import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { RELEASE_ATTEMPT_STAGES } from '../db/schema-release-ledger.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  ReleaseCheckUnevaluatedError,
  ReleaseProbesUnreadableError,
  ReleaseRosterUnusableError,
} from './blockers.js';
import { resolveReleaseChannels } from './channel.js';
import { openAttempt, readAttempt, recordAccount, settleAttempt } from './ledger.js';
import { announceMethod } from './method.js';
import { loadReleaseReadiness } from './readiness.js';
import { readReleaseRecord, recordPerformedRelease } from './recorded.js';
import {
  badRequest,
  conflict,
  declarationRefusal,
  holding,
  methodRefusal,
  notFound,
  recordRefusal,
  refuseMachineKeys,
  releaseBlockerHttp,
  undeclaredBranches,
  undeclaredProbes,
} from './refusals.js';
import {
  abortReleaseBatch,
  BatchInFlightError,
  ClaimConflictError,
  createReleaseBatch,
  findReleaseBatchRun,
  finishReleaseBatch,
  getActiveReleaseBatch,
  loadReleaseBatchContext,
  loadReleaseRoster,
  NoReleaseGateError,
  NoRunnerOnlineError,
  ReleaseBatchAbortedError,
  ReleaseBranchesUndeclaredError,
  ReleaseNotVerifiedError,
  ReleasePoolEmptyError,
  ReleaseProbesUndeclaredError,
  ReleaseRecordMissingError,
  ReleaseRunnerUndeclaredError,
} from './service.js';
import { assertRunNotHolding, ReleaseRunHoldingError, readReleaseRunState } from './state.js';
import { readLiveState } from './verify.js';

const projectParamSchema = z.object({ projectId: z.uuid() });

const createBodySchema = z
  .object({
    issueIds: z.array(z.uuid()).min(1).max(50),
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
    const { issueIds } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access) throw notFound('project not found');
    assertProjectRole(access, 'admin');

    try {
      const result = await createReleaseBatch({ projectId, issueIds, userId });
      return c.json(result, 201);
    } catch (err) {
      const declined = declarationRefusal(err);
      if (declined) throw declined;
      if (err instanceof NoReleaseGateError) throw releaseBlockerHttp(err, 'NO_RELEASE_GATE');
      if (err instanceof ReleaseRunnerUndeclaredError) {
        throw releaseBlockerHttp(err, 'RELEASE_RUNNER_UNDECLARED');
      }
      if (err instanceof ReleaseProbesUndeclaredError) throw undeclaredProbes(err);
      if (err instanceof ReleaseProbesUnreadableError) {
        throw releaseBlockerHttp(err, 'RELEASE_PROBES_UNREADABLE', { urls: err.urls });
      }
      if (err instanceof ReleaseBranchesUndeclaredError) throw undeclaredBranches(err);
      if (err instanceof ReleasePoolEmptyError) throw releaseBlockerHttp(err, 'RELEASE_POOL_EMPTY');
      if (err instanceof NoRunnerOnlineError) throw releaseBlockerHttp(err, 'NO_RUNNER_ONLINE');
      if (err instanceof ReleaseRosterUnusableError) {
        throw releaseBlockerHttp(err, err.code, { waiting: err.waiting });
      }
      if (err instanceof ReleaseCheckUnevaluatedError) {
        throw releaseBlockerHttp(err, 'RELEASE_CHECK_UNEVALUATED', { check: err.check });
      }
      if (err instanceof ClaimConflictError) {
        throw releaseBlockerHttp(err, 'CLAIM_CONFLICT', { issueIds: err.issueIds });
      }
      if (err instanceof ReleaseRecordMissingError) {
        throw releaseBlockerHttp(err, 'RELEASE_RECORD_MISSING', { issueIds: err.issueIds });
      }
      if (err instanceof BatchInFlightError) throw releaseBlockerHttp(err, 'BATCH_IN_FLIGHT');
      throw err;
    }
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
    if (!access) throw notFound('project not found');
    assertProjectRole(access, 'member');

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
    if (!access) throw notFound('project not found');
    assertProjectRole(access, 'member');

    try {
      return c.json(await loadReleaseRoster(projectId));
    } catch (err) {
      const declined = declarationRefusal(err);
      if (declined) throw declined;
      throw err;
    }
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
    if (!access) throw notFound('project not found');
    assertProjectRole(access, 'member');

    const readiness = await loadReleaseReadiness(projectId);
    if (!readiness) throw notFound('project not found');
    return c.json(readiness);
  },
);

const runParamSchema = z.object({ projectId: z.uuid(), runId: z.uuid() });

const finishBodySchema = z.object({ commit: z.string().trim().max(200).optional() }).strict();
const abortBodySchema = z.object({ reason: z.string().trim().max(2000).optional() }).strict();

/**
 * `account` has a floor because it is the whole of Rule 2 of ISS-1129: a release
 * performed by hand and a release performed by a batch are different facts, and
 * "released" with no account of how is the silent substitution this repository
 * refuses everywhere else. Twenty characters does not make an account good; it
 * makes `ok` refused.
 */
const releaseRecordBodySchema = z
  .object({
    issueIds: z.array(z.uuid()).min(1).max(50),
    commit: z.string().trim().min(7).max(200),
    account: z.string().trim().min(20).max(20_000),
    providerRef: z.string().trim().max(500).optional(),
  })
  .strict();

async function loadRunForProject(runId: string, projectId: string, userId: string) {
  const run = await findReleaseBatchRun(runId);
  if (!run || run.projectId !== projectId) throw notFound('release batch not found');

  const access = await loadProjectAccess(projectId, userId);
  if (!access) throw notFound('project not found');
  assertProjectRole(access, 'member');
}

releaseBatchRoutes.get(
  '/:projectId/release-batches/:runId',
  zValidator('param', runParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    await loadRunForProject(runId, projectId, c.get('userId'));
    try {
      return c.json(await loadReleaseBatchContext(runId));
    } catch (err) {
      if (err instanceof ReleaseBranchesUndeclaredError) throw undeclaredBranches(err);
      throw err;
    }
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

    try {
      return c.json(
        await finishReleaseBatch(runId, { type: 'user', id: userId }, c.req.valid('json')),
      );
    } catch (err) {
      if (err instanceof ReleaseNotVerifiedError) {
        throw new HTTPException(409, {
          message: err.reason,
          cause: { code: 'RELEASE_NOT_VERIFIED', reason: err.reason, live: err.live },
        });
      }
      if (err instanceof ReleaseProbesUndeclaredError) throw undeclaredProbes(err);
      if (err instanceof ReleaseBatchAbortedError) {
        throw conflict(
          'RELEASE_BATCH_ABORTED',
          'This batch was aborted, so there is nothing left to finish: its claims were released and its roster is back where the abort put it. If the release did land after all, that is a person’s call to make on each issue.',
        );
      }
      const method = methodRefusal(err);
      if (method) throw method;
      throw err;
    }
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
    const { reason } = c.req.valid('json');
    const userId = c.get('userId');
    await loadRunForProject(runId, projectId, userId);

    const result = await abortReleaseBatch(runId, reason ?? 'aborted by agent', userId);
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
    try {
      await assertRunNotHolding(runId);
    } catch (err) {
      if (err instanceof ReleaseRunHoldingError) throw holding(err);
      throw err;
    }
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
    const channels = await resolveReleaseChannels(projectId);
    const verify = channels[0]?.verify ?? null;
    const live = verify ? await readLiveState(verify) : null;
    const settled = await settleAttempt({
      runId,
      idempotencyKey: key,
      health: live?.health ?? null,
      identity: live?.identity ?? null,
      readings: live?.readings ?? null,
      verdict: live === null ? 'failed' : live.health === 'up' ? 'ok' : 'failed',
      verdictReason:
        live === null
          ? 'this project declares no verification probes, so nothing could be read'
          : live.health === 'up'
            ? `the application answered and reports ${live.identity ?? 'no commit'}`
            : `the application is not answering: ${live.unhealthy.join('; ')}`,
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
    if (!access) throw notFound('project not found');
    assertProjectRole(access, 'admin');

    try {
      const result = await recordPerformedRelease({ projectId, userId, ...c.req.valid('json') });
      return c.json(result, 201);
    } catch (err) {
      throw recordRefusal(err);
    }
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
    if (!access) throw notFound('project not found');
    assertProjectRole(access, 'member');

    const record = await readReleaseRecord(projectId, runId);
    if (!record) throw notFound('no release record under this id on this project');
    return c.json(record);
  },
);
