import { Hono } from 'hono';
import { z } from 'zod';
import { RELEASE_ATTEMPT_STAGES } from '../db/schema-release-ledger.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { badRequest, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { assertApprovalAllowsAttempt } from './approvals.js';
import { resolveReleaseChannels } from './channel.js';
import { acceptReleaseBatchFinish } from './finish-job.js';
import {
  attemptReading,
  openAttempt,
  readAttempt,
  recordAccount,
  settleAttempt,
} from './ledger.js';
import { announceMethod } from './method.js';
import { loadReleaseReadiness } from './readiness.js';
import { readReleaseRecord, recordPerformedRelease } from './recorded.js';
import { refuseMachineKeys, refuseRelease } from './refuse.js';
import {
  abortReleaseBatch,
  createReleaseBatch,
  findReleaseBatchRun,
  getActiveReleaseBatch,
  loadReleaseBatchContext,
  loadReleaseRoster,
} from './service.js';
import { readServingDeployment } from './serving.js';
import { assertRunNotHolding, readReleaseRunState } from './state.js';
import { releaseVersionRoutes } from './version-routes.js';
import { requireHeld } from '../permissions/index.js';

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
  zValidator('param', projectParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', createBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
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
  zValidator('param', projectParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
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
  zValidator('param', projectParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
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
  zValidator('param', projectParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    requireHeld(access, 'project.write');

    const readiness = await loadReleaseReadiness(projectId);
    if (!readiness) throw notFound('project not found');
    return c.json(readiness);
  },
);

releaseBatchRoutes.get(
  '/:projectId/deployment',
  zValidator('param', projectParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    requireHeld(access, 'project.write');

    // cm:edge protocol -> packages/core/src/release-batch/readiness.ts — readiness answers the
    // DECLARATION and makes no outbound request; this one reads the probes, so they stay apart
    const read = await readServingDeployment(projectId);
    if (!read.ok) {
      if (read.code === 'NO_PROJECT') throw notFound('project not found');
      throw refuseRelease(read.code, read.detail);
    }
    return c.json(read.deployment);
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
  zValidator('param', runParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    await loadRunForProject(runId, projectId, c.get('userId'));
    return c.json(await loadReleaseBatchContext(runId));
  },
);

releaseBatchRoutes.post(
  '/:projectId/release-batches/:runId/finish',
  zValidator('param', runParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', finishBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
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
  zValidator('param', runParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', abortBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
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

const attemptBodySchema = z
  .object({
    stage: z.enum(RELEASE_ATTEMPT_STAGES),
    idempotencyKey: z.string().trim().min(1).max(200),
    commit: z.string().trim().max(200).optional(),
  })
  .passthrough();

const accountBodySchema = z
  .object({
    account: z.string().trim().min(1).max(20_000),
    providerRef: z.string().trim().max(500).optional(),
    logTail: z.string().max(200_000).optional(),
  })
  .passthrough();

const methodBodySchema = z
  .object({
    skill: z.string().trim().min(1).max(200),
    loaded: z.boolean(),
    detail: z.string().trim().max(4_000).optional(),
  })
  .strict();

const attemptKeyParamSchema = z.object({
  projectId: z.uuid(),
  runId: z.uuid(),
  key: z.string().trim().min(1).max(200),
});

releaseBatchRoutes.get(
  '/:projectId/release-batches/:runId/state',
  zValidator('param', runParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
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
  zValidator('param', runParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', methodBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    await loadRunForProject(runId, projectId, c.get('userId'));
    return c.json(await announceMethod({ runId, ...c.req.valid('json') }));
  },
);

releaseBatchRoutes.post(
  '/:projectId/release-batches/:runId/attempts',
  zValidator('param', runParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', attemptBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    await loadRunForProject(runId, projectId, c.get('userId'));
    const body = c.req.valid('json') as Record<string, unknown>;
    refuseMachineKeys(body);
    await assertRunNotHolding(runId);
    await assertApprovalAllowsAttempt(runId, projectId);
    const row = await openAttempt({
      runId,
      stage: body.stage as never,
      idempotencyKey: body.idempotencyKey as string,
      commit: (body.commit as string | undefined) ?? null,
    });
    return c.json(row, 201);
  },
);

releaseBatchRoutes.post(
  '/:projectId/release-batches/:runId/attempts/:key/account',
  zValidator('param', attemptKeyParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', accountBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, runId, key } = c.req.valid('param');
    await loadRunForProject(runId, projectId, c.get('userId'));
    const body = c.req.valid('json') as Record<string, unknown>;
    refuseMachineKeys(body);
    const existing = await readAttempt(runId, key);
    if (!existing) {
      throw notFound(
        `no attempt \`${key}\` on this run — record the intent first with POST .../attempts`,
      );
    }
    await recordAccount({
      runId,
      idempotencyKey: key,
      account: body.account as string,
      providerRef: (body.providerRef as string | undefined) ?? null,
      logTail: (body.logTail as string | undefined) ?? null,
    });
    const settled = await settleAttempt({
      runId,
      idempotencyKey: key,
      ...(await attemptReading(await resolveReleaseChannels(projectId))),
    });
    return c.json(settled);
  },
);

// ISS-1129 — the release that already happened, and the read of what was written.
//
// Registered on this router rather than on one of its own, so the `use('*')`
// at the top covers them and `check-pat-surface` — which reads routes off the
// router file `index.ts` mounts — can see that both reach the fence.
releaseBatchRoutes.post(
  '/:projectId/release-records',
  zValidator('param', projectParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', releaseRecordBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
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
  zValidator('param', runParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
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
