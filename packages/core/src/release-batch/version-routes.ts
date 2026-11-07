import { REASON_PARAGRAPH_MAX } from '@forge/contracts/comments';
import { ReleaseNamingSchema } from '@forge/contracts/release-notes';
import { RELEASES_SHIPPED_MAX } from '@forge/contracts/releases';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { notFound } from '../middleware/route-errors.js';
import { invalid, noQuery, zValidator } from '../middleware/zod-validator.js';
import { holds, requiresByRule, requiresOnParam } from '../permissions/index.js';
import {
  approvalRequestSchema,
  decideApproval,
  parseDecision,
  requestApproval,
} from './approvals.js';
import { decideDraftApproval } from './draft-approval.js';
import { nameReleaseAs } from './naming.js';
import { findReleaseBatchRun } from './queries.js';
import { readRelease } from './release-read.js';
import { listReleases, listShippedReleases } from './release-read-list.js';
import { repairRelease } from './release-repair.js';
import type { ViewerFacts } from './release-view.js';

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

const projectParam = zValidator('param', z.object({ projectId: z.uuid() }));
const versionParam = zValidator(
  'param',
  z.object({ projectId: z.uuid(), version: z.string().min(1).max(40) }),
);
const runParam = zValidator('param', z.object({ projectId: z.uuid(), runId: z.uuid() }));
const approvalParam = zValidator(
  'param',
  z.object({ projectId: z.uuid(), runId: z.uuid(), approvalId: z.uuid() }),
);
const requestBody = zValidator(
  'json',
  approvalRequestSchema,
  invalid(
    'the request is { evidence: { environment, commit, reading }, note? }',
    'RELEASE_APPROVAL_SHAPE',
  ),
);
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

releaseVersionRoutes.get(
  '/:projectId/releases',
  projectParam,
  requiresOnParam('project.read', 'projectId'),
  noQuery,
  async (c) => {
    const { projectId } = c.req.valid('param');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    return c.json(await listReleases(projectId, viewerOf(c, access)));
  },
);

// The newest few releases that shipped (ISS-1070): what a page showing the last releases reads, where
// the whole list above is the Releases page's. Registered before `/:version`, which it would match.
releaseVersionRoutes.get(
  '/:projectId/releases/shipped',
  projectParam,
  requiresOnParam('project.read', 'projectId'),
  zValidator(
    'query',
    z.strictObject({ limit: z.coerce.number().int().min(1).max(RELEASES_SHIPPED_MAX) }),
    invalid(
      `the query is ?limit=n, n a whole number from 1 to ${RELEASES_SHIPPED_MAX}: how many of the newest shipped releases to read`,
      'RELEASES_SHIPPED_LIMIT',
    ),
  ),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const { limit } = c.req.valid('query');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    return c.json(await listShippedReleases(projectId, viewerOf(c, access), limit));
  },
);

releaseVersionRoutes.get(
  '/:projectId/releases/:version',
  versionParam,
  requiresOnParam('project.read', 'projectId'),
  noQuery,
  async (c) => {
    const { projectId, version } = c.req.valid('param');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    return c.json({ release: await readRelease(projectId, version, viewerOf(c, access)) });
  },
);

// A release's name and summary (REQ-40 BC-14), written by whoever may cut it: at the cut, or here
// for a release cut without them. Each is held to `ReleaseNamingSchema` and refused by name.
releaseVersionRoutes.put(
  '/:projectId/releases/:version/naming',
  versionParam,
  requiresOnParam('project.admin', 'projectId'),
  zValidator('json', ReleaseNamingSchema),
  async (c) => {
    const { projectId, version } = c.req.valid('param');
    return c.json(await nameReleaseAs(projectId, version, c.req.valid('json'), c.get('userId')));
  },
);

// A drafted release decided by a listed approver, keyed on its version, on a project that declares no
// production and so cuts no run to ask approval on (ISS-869): `{ decision, reason? }`, as a run's,
// but with no carry, since a draft is judged by no checklist (ISS-914).
releaseVersionRoutes.post(
  '/:projectId/releases/:version/approval',
  versionParam,
  requiresOnParam('releases.approve'),
  decisionBody,
  async (c) => {
    const { projectId, version } = c.req.valid('param');
    const userId = c.get('userId');
    const decision = parseDecision(c.req.valid('json'));
    return c.json(await decideDraftApproval({ projectId, version, userId, decision }), 201);
  },
);

// A release that ended `failed` though it shipped, settled to what happened by an admin's recorded
// act (ISS-761): who, why and the evidence are kept beside the failure it settles, never over it.
const repairBody = zValidator(
  'json',
  z
    .object({
      outcome: z.literal('shipped'),
      reason: z.string().trim().min(1).max(REASON_PARAGRAPH_MAX),
      evidence: z.string().trim().min(1).max(REASON_PARAGRAPH_MAX),
    })
    .strict(),
  invalid(
    'the repair is { outcome: "shipped", reason, evidence }: why it shipped, and what shows it did',
    'RELEASE_REPAIR_SHAPE',
  ),
);

releaseVersionRoutes.post(
  '/:projectId/releases/:version/repair',
  versionParam,
  requiresOnParam('project.admin'),
  repairBody,
  async (c) => {
    const { projectId, version } = c.req.valid('param');
    const { reason, evidence } = c.req.valid('json');
    const done = await repairRelease({
      projectId,
      version,
      userId: c.get('userId'),
      reason,
      evidence,
    });
    return c.json(done, done.repeated ? 200 : 201);
  },
);

releaseVersionRoutes.post(
  '/:projectId/release-batches/:runId/approvals',
  runParam,
  requiresOnParam('project.write', 'projectId'),
  requestBody,
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    const userId = c.get('userId');
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
  // the run's not-found and the decision's shape answer before releases.approve, so no floor
  requiresByRule(
    'release-batch/approvals.ts:decideApproval',
    'releases.approve on the project, once its run is found and the decision is read',
  ),
  decisionBody,
  async (c) => {
    const { projectId, runId, approvalId } = c.req.valid('param');
    const userId = c.get('userId');
    await loadProjectAccess(projectId, userId);
    await assertRunOfProject(runId, projectId);
    const decision = parseDecision(c.req.valid('json'));
    return c.json(await decideApproval({ projectId, runId, approvalId, userId, decision }));
  },
);
