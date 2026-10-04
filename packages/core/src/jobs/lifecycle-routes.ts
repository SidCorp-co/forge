import { OCCUPYING_JOB_STATUSES } from '@forge/contracts/job-machine';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { deriveSessionFinal } from '../agent-sessions/index.js';
import { publishPipelineHealthChanged } from '../issues/pipeline-health.js';
import { loadProjectAccess } from '../lib/authz.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { assertPlatformAdmin } from '../middleware/require-admin.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { forbidden } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { holds, requireHeld } from '../permissions/index.js';
import { clearRunnerLimit } from '../runners/apply-runner-limit.js';
import { clearRunnerQuarantine } from '../runners/quarantine.js';
import { failReconcileRunIfNoVerdictRecorded } from '../skills/reconcile-service.js';
import { materializeJobUsage } from '../usage-records/materialize.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { SYNTHETIC_REAP_ERRORS, syncAgentSessionLifecycle } from './agent-session-link.js';
import { cancelJob } from './cancel-job.js';
import { finalizeFailedJob } from './finalize-failure.js';
import { isResumeFailedError, reclassifyAbortedResume } from './handle-resume-failed.js';
import { readJobGate } from './job-queries.js';
import { refuseJob } from './refusals.js';
import { salvageSchema, salvageSet } from './prior-attempts.js';
import { resumeHeldJob } from './resume-job.js';
import { ackJob, confirmJobKill, finishJobFromRunner, reclaimReapedJob } from './service.js';
import type { RetryOutcome } from './retry.js';
import { jobTurnVerdictRoutes } from './turn-verdict-routes.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const jobIdParamSchema = z.object({ id: z.uuid() });

const ackBodySchema = z
  .object({
    skillsRanWith: z.record(z.string(), z.string().max(128)).optional(),
  })
  .passthrough();

const completeBodySchema = z
  .object({
    exitCode: z.number().int(),
    error: z.string().max(10_000).nullable().optional(),
    summary: z.string().max(10_000).optional(),
  })
  .strict();

const failBodySchema = z
  .object({ error: z.string().max(10_000), salvage: salvageSchema.optional() })
  .strict();

const cancelBodySchema = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .strict();

const killAckBodySchema = z
  .object({
    outcome: z.enum(['killed', 'not_found']),
  })
  .strict();

async function loadJob(jobId: string) {
  const row = await readJobGate(jobId);
  if (!row) throw notFound('job not found');
  return row;
}

export const jobLifecycleDeviceRoutes = new Hono<{ Variables: DeviceVars }>();
jobLifecycleDeviceRoutes.route('/', jobTurnVerdictRoutes);

// ISS-449 (ISS-442 C3 / I3) — explicit runner ACK for the dispatch→ack hop.
// The runner calls this right after its pre-claim preflight passes (ISS-451)
// and before spawning the agent; the first job_event batch doubles as a
// fallback ack for older runners (events-routes.ts). Idempotent: a repeat
// call (or a call racing the event fallback) keeps the first timestamp and
// reports `acked:false`. A terminal job is NOT an error — the runner treats
// ack as best-effort and must not abort the job over a late/lost ack.
jobLifecycleDeviceRoutes.post(
  '/:id/ack',
  requireDevice(),
  zValidator('param', jobIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', ackBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const device = c.get('device');

    const job = await loadJob(id);
    if (job.deviceId !== device.id) throw forbidden('job is not dispatched to this device');

    if (job.ackedAt) {
      return c.json({
        jobId: job.id,
        status: job.status,
        ackedAt: job.ackedAt.toISOString(),
        acked: false,
      });
    }

    const now = new Date();
    const updated = await ackJob(job, device.id, body.skillsRanWith ?? null, now);
    if (!updated) {
      const fresh = await loadJob(id);
      return c.json({
        jobId: fresh.id,
        status: fresh.status,
        ackedAt: fresh.ackedAt ? fresh.ackedAt.toISOString() : null,
        acked: false,
      });
    }
    return c.json({
      jobId: updated.id,
      status: updated.status,
      ackedAt: now.toISOString(),
      acked: true,
    });
  },
);

jobLifecycleDeviceRoutes.post(
  '/:id/complete',
  requireDevice(),
  zValidator('param', jobIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', completeBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const device = c.get('device');

    const job = await loadJob(id);
    if (job.deviceId !== device.id) throw forbidden('job is not dispatched to this device');

    // ISS-378 — idempotent late completion. A runner that finished real work
    // but whose /complete was lost to a core outage finds its job already
    // reaped to `failed` by a timeout/orphan sweep (server-side, not a runner
    // /fail). If it retries with success and no retry attempt has taken over,
    // accept it: flip failed→done and run the success side-effects, instead of
    // 409-discarding real work (ISS-360 lost a merged PR this way). Guarded so
    // it can't double-advance: if any retry descendant is queued/dispatched/
    // running/done, that attempt owns the outcome and we fall through to 409.
    if (
      !OCCUPYING_JOB_STATUSES.includes(job.status) &&
      input.exitCode === 0 &&
      job.status === 'failed' &&
      typeof job.error === 'string' &&
      SYNTHETIC_REAP_ERRORS.has(job.error)
    ) {
      const reclaimed = await reclaimReapedJob({ ...job, error: job.error }, device.id);
      if (reclaimed) {
        logger.warn(
          { jobId: reclaimed.id, reapedError: job.error },
          'lifecycle: reconciled a late successful completion — job had been reaped (work would otherwise be lost)',
        );
        if (reclaimed.agentSessionId) {
          void deriveSessionFinal(reclaimed.id, reclaimed.agentSessionId);
        }
        void materializeJobUsage(reclaimed);
        await syncAgentSessionLifecycle(reclaimed, 'done');
        roomManager.publish(projectRoom(reclaimed.projectId), {
          event: 'job.completed',
          data: { jobId: reclaimed.id, status: 'done', exitCode: 0 },
        });
        void clearRunnerLimit(reclaimed.runnerId, reclaimed.projectId);
        void clearRunnerQuarantine(reclaimed.runnerId, reclaimed.projectId);
        if (reclaimed.issueId) {
          await publishPipelineHealthChanged(reclaimed.projectId, [reclaimed.issueId]);
        }
        return c.json({
          jobId: reclaimed.id,
          status: 'done',
          exitCode: 0,
          retry: null,
          reconciled: true,
        });
      }
    }

    if (!OCCUPYING_JOB_STATUSES.includes(job.status)) {
      throw refuseJob('INVALID_STATE', 'job is not in a runnable state');
    }

    const status: 'done' | 'cancelled' | 'failed' =
      input.exitCode === 0 ? 'done' : input.exitCode === -1 ? 'cancelled' : 'failed';
    const effectiveError: string | null = input.error ?? null;

    let updated = await finishJobFromRunner({
      jobId: id,
      from: job.status,
      to: status,
      set: {
        exitCode: input.exitCode,
        error: effectiveError,
        finishedAt: new Date(),
      },
      reason: status === 'failed' ? (effectiveError ?? 'exit nonzero') : `lifecycle_${status}`,
      deviceId: device.id,
    });

    if (!updated) throw refuseJob('INVALID_STATE', 'job state changed mid-request');

    // ISS-283 — final authoritative derive of the agent_sessions transcript
    // from the streamed job_events (CLI runner never PATCHes the session row).
    // Fire-and-forget + best-effort so it can never block or hang /complete;
    // it never writes status, so it can't fight syncAgentSessionLifecycle below.
    if (updated.agentSessionId) {
      void deriveSessionFinal(updated.id, updated.agentSessionId);
    }
    // ISS-439 — materialize the usage_records row from the stored job_events.
    void materializeJobUsage(updated);

    if (status === 'failed') {
      let precomputedRetry: RetryOutcome | undefined;
      if (isResumeFailedError(input.error)) {
        updated = await reclassifyAbortedResume(updated);
      }
      // ISS-280 / ISS-393 — shared finalize path: auto-retry → revert to
      // entry-status (or hold the job when exhausted) → session sync →
      // broadcast → hooks → dispatch re-tick → health refresh.
      const retry = await finalizeFailedJob(updated, {
        error: effectiveError ?? 'exit nonzero',
        exitCode: input.exitCode,
        precomputedRetry,
      });
      return c.json({
        jobId: updated.id,
        status: updated.status,
        exitCode: updated.exitCode,
        retry,
      });
    }

    // done / cancelled — mirror lifecycle to the linked agent_session row so
    // /pipeline + issue detail tab reflect completion. Best-effort.
    await syncAgentSessionLifecycle(updated, status);

    await failReconcileRunIfNoVerdictRecorded(updated).catch((err) =>
      logger.warn(
        { err, jobId: updated.id, type: updated.type },
        'lifecycle: failReconcileRunIfNoVerdictRecorded failed',
      ),
    );

    roomManager.publish(projectRoom(updated.projectId), {
      event: status === 'done' ? 'job.completed' : 'job.cancelled',
      data: { jobId: updated.id, status, exitCode: updated.exitCode },
    });

    if (status === 'done') {
      void clearRunnerLimit(updated.runnerId, updated.projectId);
      void clearRunnerQuarantine(updated.runnerId, updated.projectId);
    }

    // ISS-164 — refresh pipelineHealth for the linked issue (activeSession
    // clears, queued siblings may now classify differently).
    if (updated.issueId) {
      await publishPipelineHealthChanged(updated.projectId, [updated.issueId]);
    }

    return c.json({
      jobId: updated.id,
      status: updated.status,
      exitCode: updated.exitCode,
      retry: null,
    });
  },
);

jobLifecycleDeviceRoutes.post(
  '/:id/fail',
  requireDevice(),
  zValidator('param', jobIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', failBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const device = c.get('device');

    const job = await loadJob(id);
    if (job.deviceId !== device.id) throw forbidden('job is not dispatched to this device');
    if (!OCCUPYING_JOB_STATUSES.includes(job.status)) {
      throw refuseJob('INVALID_STATE', 'job is not in a runnable state');
    }

    let updated = await finishJobFromRunner({
      jobId: id,
      from: job.status,
      to: 'failed',
      set: { error: input.error, finishedAt: new Date(), ...salvageSet(input.salvage) },
      reason: input.error,
      deviceId: device.id,
    });

    if (!updated) throw refuseJob('INVALID_STATE', 'job state changed mid-request');

    // ISS-283 — final transcript derive (see /complete). Fire-and-forget.
    if (updated.agentSessionId) {
      void deriveSessionFinal(updated.id, updated.agentSessionId);
    }
    void materializeJobUsage(updated);

    const precomputedRetry: RetryOutcome | undefined = undefined;
    if (isResumeFailedError(input.error)) {
      updated = await reclassifyAbortedResume(updated);
    }

    // ISS-280 — shared finalize path (see /complete).
    const retry = await finalizeFailedJob(updated, {
      error: input.error,
      precomputedRetry,
    });

    return c.json({
      jobId: updated.id,
      status: updated.status,
      error: updated.error,
      retry,
    });
  },
);

/**
 * ISS-785 — device-scoped kill-ack for the `job.cancel` frame the
 * kill-before-reap gate sends. Deliberately NOT a lifecycle transition: it
 * only stamps `killConfirmedAt`/`killOutcome` (first ack wins — idempotent)
 * and appends a `kill_ack` audit event, then returns 200 whether or not the
 * job is still active. `resolveKillConfirmation` (jobs/kill-gate.ts) is the
 * ONLY reader of these columns. `recorded:false` in the response means the
 * ack was audited but not stamped — see the guard below.
 */
jobLifecycleDeviceRoutes.post(
  '/:id/kill-ack',
  requireDevice(),
  zValidator('param', jobIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', killAckBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { outcome } = c.req.valid('json');
    const device = c.get('device');

    const job = await loadJob(id);
    if (job.deviceId !== device.id) throw forbidden('job is not dispatched to this device');

    const recorded = job.killRequestedAt !== null;
    await confirmJobKill(id, outcome, device.id, recorded);

    return c.json({ jobId: id, killOutcome: outcome, acked: true, recorded });
  },
);

// Auth applied per-handler — see comment in jobs/routes.ts on why a bare
// `.use('*')` would 401 device-only sibling routes.
export const jobLifecycleUserRoutes = new Hono<{ Variables: AuthVars }>();

jobLifecycleUserRoutes.post(
  '/:id/cancel',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', jobIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', cancelBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const job = await loadJob(id);
    const access = await loadProjectAccess(job.projectId, userId);
    if (!holds(access, 'project.write')) await assertPlatformAdmin(c);

    const body = c.req.valid('json');

    const result = await cancelJob(id, {
      actorUserId: userId,
      actorAgency: restActor(c).agency,
      reason: body.reason ?? 'manual cancel (REST)',
      source: 'rest',
    });
    return c.json(result);
  },
);

jobLifecycleUserRoutes.post(
  '/:id/resume',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', jobIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', cancelBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const job = await loadJob(id);
    const access = await loadProjectAccess(job.projectId, userId);
    requireHeld(access, 'project.write');

    const body = c.req.valid('json');

    const result = await resumeHeldJob(id, {
      actorUserId: userId,
      actor: restActor(c),
      reason: body.reason ?? 'manual resume (REST)',
      source: 'rest',
    });
    return c.json(result);
  },
);
