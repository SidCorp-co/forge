import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { publishPipelineHealthChanged } from '../issues/pipeline-health.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { hooks } from '../pipeline/hooks.js';
import { materializeJobUsage } from '../usage-records/materialize.js';
import { deviceRoom, projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { syncAgentSessionLifecycle } from './agent-session-link.js';
import { dispatchTickForProject } from './dispatch-tick.js';
import { finalizeFailedJob } from './finalize-failure.js';
import { handleResumeFailed, isResumeFailedError } from './handle-resume-failed.js';
import type { RetryOutcome } from './retry.js';
import { deriveSessionFinal } from './session-transcript.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const conflict = (message: string, code: string) =>
  new HTTPException(409, { message, cause: { code } });

const jobIdParamSchema = z.object({ id: z.uuid() });

const completeBodySchema = z
  .object({
    exitCode: z.number().int(),
    error: z.string().max(10_000).nullable().optional(),
    summary: z.string().max(10_000).optional(),
  })
  .strict();

const failBodySchema = z
  .object({
    error: z.string().max(10_000),
  })
  .strict();

const ACTIVE_STATUSES = new Set(['queued', 'dispatched', 'running']);
const RUNNABLE_STATUSES = new Set(['dispatched', 'running']);

// ISS-378 — `jobs.error` markers written by the SERVER-side reapers (never by
// a real runner /fail): the orphan reconcilers + stale-detector. A successful
// late /complete for a job carrying one of these means the runner actually
// finished but its report was lost (e.g. to a core outage) and a sweep reaped
// the row first — so the success is reconcilable, not a conflict.
const SYNTHETIC_REAP_ERRORS = new Set(['session_lost', 'dispatch_unclaimed', 'stale']);

async function loadJob(jobId: string) {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!row) throw notFound('job not found');
  return row;
}

export const jobLifecycleDeviceRoutes = new Hono<{ Variables: DeviceVars }>();

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
      !RUNNABLE_STATUSES.has(job.status) &&
      input.exitCode === 0 &&
      job.status === 'failed' &&
      typeof job.error === 'string' &&
      SYNTHETIC_REAP_ERRORS.has(job.error)
    ) {
      const activeRetry = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.retryOf, job.id),
            inArray(jobs.status, ['queued', 'dispatched', 'running', 'done']),
          ),
        )
        .limit(1);
      if (activeRetry.length === 0) {
        const [reclaimed] = await db
          .update(jobs)
          .set({ status: 'done', exitCode: 0, error: null, finishedAt: new Date() })
          .where(and(eq(jobs.id, id), eq(jobs.status, 'failed'), eq(jobs.error, job.error)))
          .returning();
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
          await hooks.emit('jobCompleted', {
            jobId: reclaimed.id,
            projectId: reclaimed.projectId,
            issueId: reclaimed.issueId,
            type: reclaimed.type,
          });
          void dispatchTickForProject(reclaimed.projectId);
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
    }

    if (!RUNNABLE_STATUSES.has(job.status)) {
      throw conflict('job is not in a runnable state', 'INVALID_STATE');
    }

    const status: 'done' | 'cancelled' | 'failed' =
      input.exitCode === 0 ? 'done' : input.exitCode === -1 ? 'cancelled' : 'failed';
    // Mutable companion to `input.error` for the failure paths below
    // (resume-fail / retry) that refine the reason without reassigning the
    // validated input object.
    const effectiveError: string | null = input.error ?? null;

    let [updated] = await db
      .update(jobs)
      .set({
        status,
        exitCode: input.exitCode,
        error: effectiveError,
        finishedAt: new Date(),
      })
      .where(and(eq(jobs.id, id), eq(jobs.status, job.status)))
      .returning();

    if (!updated) throw conflict('job state changed mid-request', 'INVALID_STATE');

    // ISS-283 — final authoritative derive of the agent_sessions transcript
    // from the streamed job_events (CLI runner never PATCHes the session row).
    // Fire-and-forget + best-effort so it can never block or hang /complete;
    // it never writes status, so it can't fight syncAgentSessionLifecycle below.
    if (updated.agentSessionId) {
      void deriveSessionFinal(updated.id, updated.agentSessionId);
    }
    // ISS-439 — materialize the usage_records row from the stored job_events.
    void materializeJobUsage(updated);

    // Step-handoff is best-effort context for the next step — NOT a completion
    // gate. A `done` job stays `done` whether or not the agent wrote its
    // handoff row; the next step falls back to raw issue fields when a prior
    // handoff is missing (see handoff-prefetch / handoff-policy
    // fallbackToRawIssueFieldIfMissing).

    if (status === 'failed') {
      // PR-5c — resume failure takes precedence: invalidate prior session
      // and branch by `onResumeFail` policy (fresh → retry; abort → no retry).
      let resumePolicy: 'fresh' | 'abort' | null = null;
      if (isResumeFailedError(input.error)) {
        resumePolicy = await handleResumeFailed({
          id: updated.id,
          projectId: updated.projectId,
          issueId: updated.issueId,
          payload: updated.payload,
        });
      }
      let precomputedRetry: RetryOutcome | undefined;
      if (resumePolicy === 'abort') {
        const [reclassified] = await db
          .update(jobs)
          .set({ failureReason: 'resume_failed', failureKind: 'permanent', classifierVersion: 1 })
          .where(eq(jobs.id, updated.id))
          .returning();
        if (reclassified) updated = reclassified;
        precomputedRetry = { scheduled: false };
      }
      // ISS-280 / ISS-393 — shared finalize path: auto-retry → revert to
      // entry-status (or park at `waiting` when exhausted) → session sync →
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

    roomManager.publish(projectRoom(updated.projectId), {
      event: status === 'done' ? 'job.completed' : 'job.cancelled',
      data: { jobId: updated.id, status, exitCode: updated.exitCode },
    });

    // Cancelled jobs do not emit a completion hook.
    if (status === 'done') {
      await hooks.emit('jobCompleted', {
        jobId: updated.id,
        projectId: updated.projectId,
        issueId: updated.issueId,
        type: updated.type,
      });
    }

    // ISS-40 PR-E — re-tick the project so newly-freed slots get filled.
    // Fire-and-forget; never await.
    void dispatchTickForProject(updated.projectId);

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
    if (!RUNNABLE_STATUSES.has(job.status)) {
      throw conflict('job is not in a runnable state', 'INVALID_STATE');
    }

    let [updated] = await db
      .update(jobs)
      .set({
        status: 'failed',
        error: input.error,
        finishedAt: new Date(),
      })
      .where(and(eq(jobs.id, id), eq(jobs.status, job.status)))
      .returning();

    if (!updated) throw conflict('job state changed mid-request', 'INVALID_STATE');

    // ISS-283 — final transcript derive (see /complete). Fire-and-forget.
    if (updated.agentSessionId) {
      void deriveSessionFinal(updated.id, updated.agentSessionId);
    }
    // ISS-439 — materialize the usage_records row from the stored job_events.
    void materializeJobUsage(updated);

    // PR-5c — same resume-failed branching as the user-lifecycle path.
    let resumePolicy: 'fresh' | 'abort' | null = null;
    if (isResumeFailedError(input.error)) {
      resumePolicy = await handleResumeFailed({
        id: updated.id,
        projectId: updated.projectId,
        issueId: updated.issueId,
        payload: updated.payload,
      });
    }
    let precomputedRetry: RetryOutcome | undefined;
    if (resumePolicy === 'abort') {
      const [reclassified] = await db
        .update(jobs)
        .set({ failureReason: 'resume_failed', failureKind: 'permanent', classifierVersion: 1 })
        .where(eq(jobs.id, updated.id))
        .returning();
      if (reclassified) updated = reclassified;
      precomputedRetry = { scheduled: false };
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
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const job = await loadJob(id);
    const access = await loadProjectAccess(job.projectId, userId);
    assertProjectRole(access, 'member', 'not a project member');

    if (!ACTIVE_STATUSES.has(job.status)) {
      throw conflict('job is not cancellable', 'NOT_CANCELLABLE');
    }

    // Queued, no device yet → transition straight to cancelled.
    if (job.status === 'queued') {
      const [updated] = await db
        .update(jobs)
        .set({ status: 'cancelled', finishedAt: new Date(), cancellationRequested: true })
        .where(and(eq(jobs.id, id), eq(jobs.status, 'queued')))
        .returning();
      if (!updated) throw conflict('job state changed mid-request', 'NOT_CANCELLABLE');

      await syncAgentSessionLifecycle(updated, 'cancelled');

      roomManager.publish(projectRoom(updated.projectId), {
        event: 'job.cancelled',
        data: { jobId: updated.id, status: 'cancelled' },
      });

      // Cancelling a queued job frees a slot — re-tick.
      void dispatchTickForProject(updated.projectId);

      // ISS-164 — see /complete comment.
      if (updated.issueId) {
        await publishPipelineHealthChanged(updated.projectId, [updated.issueId]);
      }

      return c.json({
        jobId: updated.id,
        status: updated.status,
        cancellationRequested: updated.cancellationRequested,
      });
    }

    // Dispatched/running → mark request, push to device, let /complete finalize.
    const [updated] = await db
      .update(jobs)
      .set({ cancellationRequested: true })
      .where(eq(jobs.id, id))
      .returning();
    if (!updated) throw notFound('job not found');

    if (updated.deviceId) {
      roomManager.publish(deviceRoom(updated.deviceId), {
        event: 'job.cancel',
        data: { jobId: updated.id },
      });
    }
    roomManager.publish(projectRoom(updated.projectId), {
      event: 'job.cancelRequested',
      data: { jobId: updated.id },
    });

    return c.json({
      jobId: updated.id,
      status: updated.status,
      cancellationRequested: updated.cancellationRequested,
    });
  },
);
