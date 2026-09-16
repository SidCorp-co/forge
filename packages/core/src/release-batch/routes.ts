// ISS-764 — REST surface for batch release.
//
// POST /:projectId/release-batches — create + claim a new batch (returns {runId,jobId,issueIds})
// GET  /:projectId/release-batches/active — returns the active batch for the project, or null
// GET  /:projectId/release-batches/:runId — batch context: roster, branches, deployPlanned
// POST /:projectId/release-batches/:runId/finish — close every claimed issue
// POST /:projectId/release-batches/:runId/abort — release the claims, cancel the run, close no issue
// POST /:projectId/release-batches/:runId/method — announce the method this run loaded
// GET  /:projectId/release-batches/:runId/state — roster + ledger + a live probe reading + bounds
// POST /:projectId/release-batches/:runId/attempts — record the INTENT of one act
// POST /:projectId/release-batches/:runId/attempts/:key/account — the agent's account of that act

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { RELEASE_ATTEMPT_STAGES } from '../db/schema-release-ledger.js';
import { RELEASE_RECORD_REMEDY } from '../issues/release-record-required.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { resolveReleaseChannels } from './channel.js';
import { openAttempt, readAttempt, recordAccount, settleAttempt } from './ledger.js';
import { announceMethod } from './method.js';
import { loadReleaseReadiness } from './readiness.js';
import {
  badRequest,
  conflict,
  declarationRefusal,
  holding,
  methodRefusal,
  notFound,
  refuseMachineKeys,
  serviceUnavailable,
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
      if (err instanceof NoReleaseGateError) {
        throw conflict('NO_RELEASE_GATE', 'This project has no release gate configured');
      }
      if (err instanceof ReleaseRunnerUndeclaredError) {
        throw conflict(
          'RELEASE_RUNNER_UNDECLARED',
          'This project declares a release model but no live deploy binding names a release runner — set `releaseRunnerLabel` on one, and label the box that holds the deploy credential',
        );
      }
      if (err instanceof ReleaseProbesUndeclaredError) throw undeclaredProbes();
      if (err instanceof ReleaseBranchesUndeclaredError) throw undeclaredBranches();
      if (err instanceof ReleasePoolEmptyError) {
        throw serviceUnavailable(
          'RELEASE_POOL_EMPTY',
          `No runner carries the release label \`${err.label}\`, so nothing here may deploy`,
        );
      }
      if (err instanceof NoRunnerOnlineError) {
        throw serviceUnavailable('NO_RUNNER_ONLINE', 'No runner is online for this project');
      }
      if (err instanceof ClaimConflictError) {
        throw conflict(
          'CLAIM_CONFLICT',
          'One or more issues could not be claimed (wrong status or already in a batch)',
        );
      }
      if (err instanceof ReleaseRecordMissingError) {
        throw conflict(
          'RELEASE_RECORD_MISSING',
          `${err.issueIds.length} issue(s) in this batch have no release note, and closing them ` +
            `would claim a ship nobody wrote anything about. ${RELEASE_RECORD_REMEDY}`,
        );
      }
      if (err instanceof BatchInFlightError) {
        throw conflict(
          'BATCH_IN_FLIGHT',
          'A batch release is already in progress for this project',
        );
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

const runParamSchema = z.object({ projectId: z.uuid(), runId: z.uuid() });

const finishBodySchema = z.object({ commit: z.string().trim().max(200).optional() }).strict();
const abortBodySchema = z.object({ reason: z.string().trim().max(2000).optional() }).strict();

// cm:guard resolve the run FIRST and refuse when `context.projectId` differs from the id in the path — the path id is what the PAT fence bites on, so accepting a runId that belongs to another project is exactly how a token scoped to project A finishes project B's release. The MCP tool this replaces read the project OFF the run and could not have this bug; a project-scoped URL can, and only this comparison stops it.
// cm:guard ownership only — no release plan, no branches. `abort` and `finish` must answer for a run whose project has since lost its branch declaration (or anything else the plan needs): abort is the agent's escape hatch, and an escape hatch that 500s leaves the run `running` with its claims held. Measured 2026-09-03: the three lifecycle routes all threw RELEASE_BRANCHES_UNDECLARED from here.
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
      if (err instanceof ReleaseBranchesUndeclaredError) throw undeclaredBranches();
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
      // cm:guard a refused verification is a 409 the caller ACTS on (abort with this reason), not a 500 — `reason` and `live` must survive into the body or the agent cannot tell "the deploy did not land" from "the server broke".
      if (err instanceof ReleaseNotVerifiedError) {
        throw new HTTPException(409, {
          message: err.reason,
          cause: { code: 'RELEASE_NOT_VERIFIED', reason: err.reason, live: err.live },
        });
      }
      if (err instanceof ReleaseProbesUndeclaredError) throw undeclaredProbes();
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
    // cm:guard `releasedIds` is kept under its old name because the release agent's protocol reads it; the rest is added beside it. What the abort did to the RUN has to reach the caller, or an abort on a run something already concluded goes on looking exactly like one that called off a live release.
    return c.json({ aborted: true, releasedIds: result.claimsCleared, ...result });
  },
);

// cm:guard `health`, `identity`, `verdict`, `verdictReason` and `readings` are refused BY NAME
// rather than dropped by `.strict()`. A caller that sends one has misread what this route is for,
// and the whole table exists because "the release happened" used to be a sentence an agent wrote —
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

// cm:guard the INTENT goes down before the act, which is why this route exists at all rather than
// one route posted afterwards. A ledger written after the fact records only what finished, so a
// release killed mid-deploy leaves nothing — and that is the release worth reading about.
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

// cm:guard the account is accepted on a HOLDING run, unlike the attempt above. An agent already
// mid-act must still be able to say what happened, or a holding run's last act is the one nothing
// is recorded about — which is the act worth reading.
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
    // cm:guard core's reading is taken HERE, at the moment the account lands, and from the project's
    // own probes. It is what makes the two halves an account and its backing rather than one claim
    // written twice: they are about the same act, taken at the same moment, by two parties.
    // cm:why the FIRST channel's probes: an attempt is one reading at one moment, and the run carries
    // one `commitBefore` to compare it against. A set whose members verify separately is its own issue
    // — ISS-1046 widened what core RETURNS, not what an attempt records.
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
