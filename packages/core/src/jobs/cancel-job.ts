import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { publishPipelineHealthChanged } from '../issues/pipeline-health.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { failReconcileRunForFailedJob } from '../skills/reconcile-service.js';
import { deviceRoom, projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { syncAgentSessionLifecycle } from './agent-session-link.js';
import { insertInterventionEvent } from './intervention-event.js';

/** Job statuses from which a single-job cancel is permitted. */
export const CANCELLABLE_STATUSES = new Set(['queued', 'dispatched', 'running', 'held']);

/**
 * Statuses with no device attached yet, so a cancel flips them straight to
 * `cancelled` instead of asking a runner to stop.
 */
const NO_DEVICE_STATUSES = new Set(['queued', 'held']);

/**
 * Transport-neutral failure raised by {@link cancelJob}. Callers map `code` to
 * their own surface: REST → HTTP 404/409, MCP → `Error('CODE: message')`.
 */
export class JobCancelError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'NOT_CANCELLABLE',
    message: string,
  ) {
    super(message);
    this.name = 'JobCancelError';
  }
}

export interface CancelJobOptions {
  /** User id of the acting principal — recorded in the audit event. */
  actorUserId: string;
  actorAgency: ActorAgency;
  /** Human/automation-supplied reason — recorded in the audit event. */
  reason: string;
  /** Which surface invoked the cancel. */
  source: 'rest' | 'mcp';
}

export interface CancelJobResult {
  jobId: string;
  status: string;
  cancellationRequested: boolean;
}

export async function cancelJob(jobId: string, opts: CancelJobOptions): Promise<CancelJobResult> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw new JobCancelError('NOT_FOUND', 'job not found');

  if (!CANCELLABLE_STATUSES.has(job.status)) {
    throw new JobCancelError('NOT_CANCELLABLE', 'job is not cancellable');
  }

  const previousStatus = job.status;

  if (NO_DEVICE_STATUSES.has(job.status)) {
    const updated = await db.transaction(async (tx) => {
      const [row] = await applyKernelTransition(tx, {
        entity: 'job',
        to: 'cancelled',
        set: { finishedAt: new Date(), cancellationRequested: true },
        where: and(eq(jobs.id, jobId), eq(jobs.status, previousStatus)),
        fromStatus: previousStatus,
        reason: opts.reason,
        actor: { type: 'user', id: opts.actorUserId, agency: opts.actorAgency },
        source: 'cancel',
      });
      if (!row) return null;
      await insertInterventionEvent(tx, { ...opts, ...auditFor(row, previousStatus) });
      return row;
    });
    if (!updated) {
      throw new JobCancelError('NOT_CANCELLABLE', 'job state changed mid-request');
    }

    await syncAgentSessionLifecycle(updated, 'cancelled');

    await failReconcileRunForFailedJob(updated).catch((err) =>
      logger.warn(
        { err, jobId: updated.id, type: updated.type },
        'cancelJob: failReconcileRunForFailedJob failed',
      ),
    );

    roomManager.publish(projectRoom(updated.projectId), {
      event: 'job.cancelled',
      data: { jobId: updated.id, status: 'cancelled' },
    });

    if (updated.issueId) {
      await publishPipelineHealthChanged(updated.projectId, [updated.issueId]);
    }

    return {
      jobId: updated.id,
      status: updated.status,
      cancellationRequested: updated.cancellationRequested,
    };
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(jobs)
      .set({ cancellationRequested: true })
      .where(eq(jobs.id, jobId))
      .returning();
    if (!row) return null;
    await insertInterventionEvent(tx, { ...opts, ...auditFor(row, previousStatus) });
    return row;
  });
  if (!updated) throw new JobCancelError('NOT_FOUND', 'job not found');

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

  return {
    jobId: updated.id,
    status: updated.status,
    cancellationRequested: updated.cancellationRequested,
  };
}

const auditFor = (row: { id: string; issueId: string | null }, previousStatus: string) =>
  ({ jobId: row.id, issueId: row.issueId, previousStatus, action: 'cancel' }) as const;
