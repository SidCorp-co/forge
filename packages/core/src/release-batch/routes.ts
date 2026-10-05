import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { createReleaseBatch } from './create.js';
import { abortReleaseBatch } from './finish.js';
import { acceptReleaseBatchFinish } from './finish-job.js';
import { announceMethod } from './method.js';
import {
  findReleaseBatchRun,
  getActiveReleaseBatch,
  loadReleaseBatchContext,
  loadReleaseRoster,
} from './queries.js';
import { loadReleaseReadiness } from './readiness.js';
import { readReleaseRecord, recordPerformedRelease } from './recorded.js';
import { readReleaseRunState } from './state.js';
import { releaseVersionRoutes } from './version-routes.js';

const projectParamSchema = z.object({ projectId: z.uuid() });

/** A roster names each issue once; a uuid is one id in either letter case. */
const rosterIdsSchema = z.array(z.uuid()).superRefine((ids, ctx) => {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id.toLowerCase())) {
      ctx.addIssue({
        code: 'custom',
        message: `issueIds names ${id} more than once, counting either letter case as the same id: send each issue once.`,
      });
      return;
    }
    seen.add(id.toLowerCase());
  }
});

const createBodySchema = z
  .object({
    /**
     * No size here: `collectReleaseBlockers` owns the limit and the empty gate,
     * so both are refused by the code readiness lists them under rather than as
     * a schema's `Invalid input` (ISS-1127 criterion 1).
     */
    issueIds: rosterIdsSchema,
    /**
     * The version of a FAILED release being cut again, which raises the patch digit instead of the
     * minor. Not validated for shape here: `cutReleaseVersion` refuses a value that is not a
     * version with the same named refusal that rules on the four other ways a re-cut can be wrong,
     * and one refusal carrying the whole rule beats a zod message carrying half of it.
     */
    recutOf: z.string().trim().max(100).optional(),
  })
  .strict();

export const releaseBatchRoutes = new Hono<{ Variables: AuthVars }>();
releaseBatchRoutes.use('*', requireAuth(), assertEmailVerified());

releaseBatchRoutes.post(
  '/:projectId/release-batches',
  zValidator('param', projectParamSchema),
  zValidator('json', createBodySchema),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const { issueIds, recutOf } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.admin');

    const result = await createReleaseBatch({ projectId, issueIds, userId, recutOf });
    return c.json(result, 201);
  },
);

releaseBatchRoutes.get(
  '/:projectId/release-batches/active',
  zValidator('param', projectParamSchema),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.write');

    const active = await getActiveReleaseBatch(projectId);
    return c.json(active ?? null);
  },
);

releaseBatchRoutes.get(
  '/:projectId/release-batches/roster',
  zValidator('param', projectParamSchema),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.write');

    return c.json(await loadReleaseRoster(projectId));
  },
);

releaseBatchRoutes.get(
  '/:projectId/release-readiness',
  zValidator('param', projectParamSchema),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    requireHeld(access, 'project.write');

    const readiness = await loadReleaseReadiness(projectId);
    if (!readiness) throw notFound('project not found');
    return c.json(readiness);
  },
);

const runParamSchema = z.object({ projectId: z.uuid(), runId: z.uuid() });

const finishBodySchema = z.object({ commit: z.string().trim().max(200).optional() }).strict();
const abortBodySchema = z
  .object({
    reason: z.string().trim().max(2000).optional(),
    /**
     * What to do with a roster whose run already promoted. Absent is `hold`, which is what this
     * door did before the choice existed (ISS-1199).
     */
    promotedRoster: z.enum(['hold', 'return-to-gate']).optional(),
  })
  .strict();

/**
 * `account` has a floor because it is the whole of Rule 2 of ISS-1129: a release
 * performed by hand and a release performed by a batch are different facts, and
 * "released" with no account of how is the silent substitution this repository
 * refuses everywhere else. Twenty characters does not make an account good; it
 * makes `ok` refused.
 */
const releaseRecordBodySchema = z
  .object({
    issueIds: rosterIdsSchema.min(1),
    commit: z.string().trim().min(1).max(200),
    account: z.string().trim().min(20).max(20_000),
    providerRef: z.string().trim().max(500).optional(),
  })
  .strict();

async function loadRunForProject(runId: string, projectId: string, userId: string) {
  const run = await findReleaseBatchRun(runId);
  if (!run || run.projectId !== projectId) throw notFound('release batch not found');

  const access = await loadProjectAccess(projectId, userId);
  requireHeld(access, 'project.write');
}

releaseBatchRoutes.get(
  '/:projectId/release-batches/:runId',
  zValidator('param', runParamSchema),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    await loadRunForProject(runId, projectId, c.get('userId'));
    return c.json(await loadReleaseBatchContext(runId));
  },
);

releaseBatchRoutes.post(
  '/:projectId/release-batches/:runId/finish',
  zValidator('param', runParamSchema),
  zValidator('json', finishBodySchema),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    const userId = c.get('userId');
    await loadRunForProject(runId, projectId, userId);

    const accepted = await acceptReleaseBatchFinish(runId, restActor(c), c.req.valid('json'));
    return c.json(
      { runId, finish: accepted.finish },
      accepted.finish.state === 'finished' ? 200 : 202,
    );
  },
);

releaseBatchRoutes.post(
  '/:projectId/release-batches/:runId/abort',
  zValidator('param', runParamSchema),
  zValidator('json', abortBodySchema),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    const { reason, promotedRoster } = c.req.valid('json');
    const userId = c.get('userId');
    await loadRunForProject(runId, projectId, userId);

    const result = await abortReleaseBatch(runId, reason ?? 'aborted by agent', userId, {
      promotedRoster,
    });
    return c.json({ aborted: true, releasedIds: result.claimsCleared, ...result });
  },
);

const methodBodySchema = z
  .object({
    skill: z.string().trim().min(1).max(200),
    loaded: z.boolean(),
    detail: z.string().trim().max(4_000).optional(),
  })
  .strict();

releaseBatchRoutes.get(
  '/:projectId/release-batches/:runId/state',
  zValidator('param', runParamSchema),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    await loadRunForProject(runId, projectId, c.get('userId'));
    const state = await readReleaseRunState(runId);
    if (!state) throw notFound('release batch not found');
    return c.json(state);
  },
);

releaseBatchRoutes.post(
  '/:projectId/release-batches/:runId/method',
  zValidator('param', runParamSchema),
  zValidator('json', methodBodySchema),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    await loadRunForProject(runId, projectId, c.get('userId'));
    return c.json(await announceMethod({ runId, ...c.req.valid('json') }));
  },
);

// ISS-1129 — the release that already happened, and the read of what was written.
//
// Registered on this router rather than on one of its own, so the `use('*')`
// at the top covers them and `check-pat-surface` — which reads routes off the
// router file `index.ts` mounts — can see that both reach the fence.
releaseBatchRoutes.post(
  '/:projectId/release-records',
  zValidator('param', projectParamSchema),
  zValidator('json', releaseRecordBodySchema),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.admin');

    const result = await recordPerformedRelease({ projectId, userId, ...c.req.valid('json') });
    return c.json(result, 201);
  },
);

releaseBatchRoutes.get(
  '/:projectId/release-records/:runId',
  zValidator('param', runParamSchema),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    requireHeld(access, 'project.write');

    const record = await readReleaseRecord(projectId, runId);
    if (!record) throw notFound('no release record under this id on this project');
    return c.json(record);
  },
);

releaseBatchRoutes.route('/', releaseVersionRoutes);
