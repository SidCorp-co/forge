import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { holds, requireHeld } from '../permissions/index.js';
import {
  approvalRequestSchema,
  decideApproval,
  parseDecision,
  requestApproval,
} from './approvals.js';
import { refuseRelease } from './refuse.js';
import { listReleases, readRelease } from './release-read.js';
import type { ViewerFacts } from './release-view.js';
import { findReleaseBatchRun } from './service.js';

export const releaseVersionRoutes = new Hono<{ Variables: AuthVars }>();
releaseVersionRoutes.use('/:projectId/releases', requireAuth(), assertEmailVerified());
releaseVersionRoutes.use('/:projectId/releases/*', requireAuth(), assertEmailVerified());
releaseVersionRoutes.use(
  '/:projectId/release-batches/:runId/approvals',
  requireAuth(),
  assertEmailVerified(),
);
releaseVersionRoutes.use(
  '/:projectId/release-batches/:runId/approvals/*',
  requireAuth(),
  assertEmailVerified(),
);

const projectParam = zValidator('param', z.object({ projectId: z.uuid() }), (r) => {
  if (!r.success) throw badRequest(r.error);
});
const versionParam = zValidator(
  'param',
  z.object({ projectId: z.uuid(), version: z.string().min(1).max(40) }),
  (r) => {
    if (!r.success) throw badRequest(r.error);
  },
);
const runParam = zValidator('param', z.object({ projectId: z.uuid(), runId: z.uuid() }), (r) => {
  if (!r.success) throw badRequest(r.error);
});
const approvalParam = zValidator(
  'param',
  z.object({ projectId: z.uuid(), runId: z.uuid(), approvalId: z.uuid() }),
  (r) => {
    if (!r.success) throw badRequest(r.error);
  },
);
const requestBody = zValidator('json', approvalRequestSchema, (r) => {
  if (!r.success) {
    throw refuseRelease(
      'RELEASE_APPROVAL_SHAPE',
      `the request is { evidence: { environment, commit, reading }, note? }: ${r.error.issues
        .map((i) => `${i.path.join('.') || '(body)'} ${i.message}`)
        .join('; ')}`,
    );
  }
});
const decisionBody = zValidator('json', z.unknown());

async function assertRunOfProject(runId: string, projectId: string): Promise<void> {
  const run = await findReleaseBatchRun(runId);
  if (!run || run.projectId !== projectId) throw notFound('release batch not found');
}

function viewerOf(
  c: { get: (k: 'userId' | 'agency') => unknown },
  access: Awaited<ReturnType<typeof loadProjectAccess>>,
): ViewerFacts | null {
  const userId = c.get('userId');
  const agency = c.get('agency');
  if (typeof userId !== 'string' || (agency !== 'human' && agency !== 'agent')) return null;
  return {
    userId,
    agency,
    isAdmin: holds(access, 'project.admin'),
    mayApprove: holds(access, 'releases.approve'),
  };
}

releaseVersionRoutes.get('/:projectId/releases', projectParam, async (c) => {
  const { projectId } = c.req.valid('param');
  const access = await loadProjectAccess(projectId, c.get('userId'));
  requireHeld(access, 'project.read');
  return c.json(await listReleases(projectId, viewerOf(c, access)));
});

releaseVersionRoutes.get('/:projectId/releases/:version', versionParam, async (c) => {
  const { projectId, version } = c.req.valid('param');
  const access = await loadProjectAccess(projectId, c.get('userId'));
  requireHeld(access, 'project.read');
  return c.json({ release: await readRelease(projectId, version, viewerOf(c, access)) });
});

releaseVersionRoutes.post(
  '/:projectId/release-batches/:runId/approvals',
  runParam,
  requestBody,
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    const userId = c.get('userId');
    requireHeld(await loadProjectAccess(projectId, userId), 'project.write');
    await assertRunOfProject(runId, projectId);
    return c.json(
      await requestApproval({ projectId, runId, userId, body: c.req.valid('json') }),
      201,
    );
  },
);

releaseVersionRoutes.post(
  '/:projectId/release-batches/:runId/approvals/:approvalId/decision',
  approvalParam,
  decisionBody,
  async (c) => {
    const { projectId, runId, approvalId } = c.req.valid('param');
    const userId = c.get('userId');
    const agency = c.get('agency');
    if (!agency)
      throw new Error('release-batch: a decision reached its handler without an auth gate');
    await loadProjectAccess(projectId, userId);
    await assertRunOfProject(runId, projectId);
    const decision = parseDecision(c.req.valid('json'));
    return c.json(await decideApproval({ projectId, runId, approvalId, userId, decision }));
  },
);
