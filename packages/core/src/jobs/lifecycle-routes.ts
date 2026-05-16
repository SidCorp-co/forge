import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { hooks } from '../pipeline/hooks.js';
import { setManualHoldBlock } from '../pipeline/manual-hold.js';
import { deviceRoom, projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { syncAgentSessionLifecycle } from './agent-session-link.js';
import { dispatchTickForProject } from './dispatch-tick.js';
import { scheduleAutoRetryOnce } from './retry.js';

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
    if (!RUNNABLE_STATUSES.has(job.status)) {
      throw conflict('job is not in a runnable state', 'INVALID_STATE');
    }

    const status = input.exitCode === 0 ? 'done' : input.exitCode === -1 ? 'cancelled' : 'failed';

    const [updated] = await db
      .update(jobs)
      .set({
        status,
        exitCode: input.exitCode,
        error: input.error ?? null,
        finishedAt: new Date(),
      })
      .where(and(eq(jobs.id, id), eq(jobs.status, job.status)))
      .returning();

    if (!updated) throw conflict('job state changed mid-request', 'INVALID_STATE');

    let retry: { scheduled: boolean; newJobId?: string } | null = null;
    if (status === 'failed') {
      retry = await scheduleAutoRetryOnce(updated, input.error ?? 'exit nonzero');
      if (!retry.scheduled && updated.issueId) {
        await setManualHoldBlock({
          issueId: updated.issueId,
          context: {
            step: updated.type,
            trigger: 'job_failed',
            classification: {
              kind:
                updated.failureKind === 'transient'
                  ? 'transient_network'
                  : updated.failureKind === 'permanent'
                    ? 'permanent_invalid'
                    : 'unknown',
              reason: updated.failureReason ?? input.error ?? 'exit nonzero',
              evidence: { jobId: updated.id, exitCode: input.exitCode },
            },
            attempts: updated.attempts,
            lastFailureAt: new Date().toISOString(),
            suggestedActions: ['resume', 'skip-step', 'close'],
          },
        });
      }
    }

    // Mirror lifecycle to the linked agent_session row so /pipeline + issue
    // detail tab reflect completion. Best-effort.
    // ISS-101 — pass retryPending so we leave the parent pipeline_run open
    // when a retry has just been scheduled; the retry shares the same run.
    await syncAgentSessionLifecycle(updated, status, {
      retryPending: retry?.scheduled === true,
    });

    roomManager.publish(projectRoom(updated.projectId), {
      event:
        status === 'done'
          ? 'job.completed'
          : status === 'cancelled'
            ? 'job.cancelled'
            : 'job.failed',
      data: { jobId: updated.id, status, exitCode: updated.exitCode },
    });

    // ISS-20 — emit hooks AFTER scheduleRetry so PM subscribers see the
    // populated `failureKind`. Cancelled jobs do not emit either event.
    if (status === 'failed') {
      await hooks.emit('jobFailed', {
        jobId: updated.id,
        projectId: updated.projectId,
        issueId: updated.issueId,
        type: updated.type,
        failureKind: updated.failureKind ?? null,
        failureReason: updated.failureReason ?? null,
      });
    } else if (status === 'done') {
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

    return c.json({
      jobId: updated.id,
      status: updated.status,
      exitCode: updated.exitCode,
      retry,
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

    const [updated] = await db
      .update(jobs)
      .set({
        status: 'failed',
        error: input.error,
        finishedAt: new Date(),
      })
      .where(and(eq(jobs.id, id), eq(jobs.status, job.status)))
      .returning();

    if (!updated) throw conflict('job state changed mid-request', 'INVALID_STATE');

    const retry = await scheduleAutoRetryOnce(updated, input.error);
    if (!retry.scheduled && updated.issueId) {
      await setManualHoldBlock({
        issueId: updated.issueId,
        context: {
          step: updated.type,
          trigger: 'job_failed',
          classification: {
            kind:
              updated.failureKind === 'transient'
                ? 'transient_network'
                : updated.failureKind === 'permanent'
                  ? 'permanent_invalid'
                  : 'unknown',
            reason: updated.failureReason ?? input.error,
            evidence: { jobId: updated.id },
          },
          attempts: updated.attempts,
          lastFailureAt: new Date().toISOString(),
          suggestedActions: ['resume', 'skip-step', 'close'],
        },
      });
    }

    await syncAgentSessionLifecycle(updated, 'failed', {
      retryPending: retry?.scheduled === true,
    });

    roomManager.publish(projectRoom(updated.projectId), {
      event: 'job.failed',
      data: { jobId: updated.id, status: 'failed', error: updated.error },
    });

    await hooks.emit('jobFailed', {
      jobId: updated.id,
      projectId: updated.projectId,
      issueId: updated.issueId,
      type: updated.type,
      failureKind: updated.failureKind ?? null,
      failureReason: updated.failureReason ?? null,
    });

    void dispatchTickForProject(updated.projectId);

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
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

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
