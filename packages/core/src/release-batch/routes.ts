import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { resolveReleaseChannels } from './channel.js';
import { acceptReleaseBatchFinish } from './finish-job.js';
import {
  attemptReading,
  openAttempt,
  readAttempt,
  recordAccount,
  settleAttempt,
} from './ledger.js';
import { lookAtBatch } from './look.js';
import { announceMethod } from './method.js';
import { loadReleaseReadiness } from './readiness.js';
import { readReleaseRecord, recordPerformedRelease } from './recorded.js';
import {
  badRequest,
  conflict,
  declarationRefusal,
  finishRefusal,
  holding,
  issuesUnnamed,
  lookRefusal,
  notFound,
  recordRefusal,
  refuseMachineKeys,
  releaseBlockerHttp,
  reportedRefusal,
} from './refusals.js';
import {
  abortBodySchema,
  accountBodySchema,
  attemptBodySchema,
  attemptKeyParamSchema,
  createBodySchema,
  finishBodySchema,
  lookBodySchema,
  methodBodySchema,
  projectParamSchema,
  releaseRecordBodySchema,
  runParamSchema,
} from './route-schemas.js';
import {
  abortReleaseBatch,
  BatchInFlightError,
  ClaimConflictError,
  createReleaseBatch,
  findReleaseBatchRun,
  getActiveReleaseBatch,
  loadReleaseBatchContext,
  loadReleaseRoster,
  NoReleaseGateError,
  ReleaseIssuesUnnamedError,
  ReleaseRecutRefusedError,
  ReleaseVersionConflictError,
  ReleaseVersionExhaustedError,
} from './service.js';
import { readServingDeployment } from './serving.js';
import { assertRunNotHolding, ReleaseRunHoldingError, readReleaseRunState } from './state.js';

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
    const { issueIds, recutOf, carried } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access) throw notFound('project not found');
    assertProjectRole(access, 'admin');

    try {
      const result = await createReleaseBatch({ projectId, issueIds, userId, recutOf, carried });
      return c.json(result, 201);
    } catch (err) {
      // Every reason the enumerator found answers from its own entry, so the
      // arms below are only for what is thrown after it: a race at the claim or
      // the enqueue, a plan read, an empty list beside a gate that holds work.
      const reported = reportedRefusal(err);
      if (reported) throw reported;
      const declined = declarationRefusal(err);
      if (declined) throw declined;
      if (err instanceof NoReleaseGateError) throw releaseBlockerHttp(err, 'NO_RELEASE_GATE');
      if (err instanceof ClaimConflictError) {
        throw releaseBlockerHttp(err, 'CLAIM_CONFLICT', err.details ?? { issueIds: err.issueIds });
      }
      if (err instanceof BatchInFlightError) throw releaseBlockerHttp(err, 'BATCH_IN_FLIGHT');
      if (err instanceof ReleaseIssuesUnnamedError) throw issuesUnnamed(projectId);
      if (err instanceof ReleaseRecutRefusedError) {
        throw conflict('RELEASE_RECUT_REFUSED', err.message);
      }
      if (err instanceof ReleaseVersionConflictError) {
        throw conflict('RELEASE_VERSION_CONFLICT', err.message);
      }
      if (err instanceof ReleaseVersionExhaustedError) {
        throw conflict('RELEASE_VERSION_EXHAUSTED', err.message);
      }
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

releaseBatchRoutes.get(
  '/:projectId/deployment',
  zValidator('param', projectParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    if (!access) throw notFound('project not found');
    assertProjectRole(access, 'member');

    // cm:edge protocol -> packages/core/src/release-batch/readiness.ts — readiness answers the
    // DECLARATION and makes no outbound request; this one reads the probes, so they stay apart
    const read = await readServingDeployment(projectId);
    if (!read.ok) {
      if (read.code === 'NO_PROJECT') throw notFound('project not found');
      throw new HTTPException(409, { message: read.detail, cause: { code: read.code } });
    }
    return c.json(read.deployment);
  },
);

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

    try {
      const accepted = await acceptReleaseBatchFinish(
        runId,
        { type: 'user', id: userId },
        c.req.valid('json'),
      );
      return c.json(
        { runId, finish: accepted.finish },
        accepted.finish.state === 'finished' ? 200 : 202,
      );
    } catch (err) {
      const refused = finishRefusal(err);
      if (refused) throw refused;
      throw err;
    }
  },
);

// ISS-1282 — the agent decides when Forge reads the live bindings; the finish closes on what it kept.
releaseBatchRoutes.post(
  '/:projectId/release-batches/:runId/readings',
  zValidator('param', runParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', lookBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    const userId = c.get('userId');
    await loadRunForProject(runId, projectId, userId);

    try {
      return c.json(await lookAtBatch({ runId, takenBy: userId, ...c.req.valid('json') }), 201);
    } catch (err) {
      const refused = lookRefusal(err);
      if (refused) throw refused;
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
    const { reason, promotedRoster } = c.req.valid('json');
    const userId = c.get('userId');
    await loadRunForProject(runId, projectId, userId);

    const result = await abortReleaseBatch(runId, reason ?? 'aborted by agent', userId, {
      promotedRoster,
    });
    return c.json({ aborted: true, releasedIds: result.claimsCleared, ...result });
  },
);

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
