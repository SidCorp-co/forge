import { JOB_MACHINE, LIVE_JOB_STATUSES } from '@forge/contracts/job-machine';
import type { ActorAgency } from '@forge/contracts/permissions';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { publishPipelineHealthChanged } from '../issues/index.js';
import { deviceRoom, projectRoom, roomManager } from '../lib/rooms.js';
import { transition } from '../lifecycle/index.js';
import { notFound } from '../middleware/route-errors.js';
import { syncAgentSessionLifecycle } from './agent-session-link.js';
import { insertInterventionEvent } from './intervention-event.js';
import { refuseJob } from './refusals.js';

/**
 * Statuses with no device attached yet, so a cancel flips them straight to
 * `cancelled` instead of asking a runner to stop.
 */
const NO_DEVICE_STATUSES = new Set(['queued', 'held']);

interface CancelJobOptions {
  /** User id of the acting principal — recorded in the audit event. */
  actorUserId: string;
  actorAgency: ActorAgency;
  /** Human/automation-supplied reason — recorded in the audit event. */
  reason: string;
  /** Which surface invoked the cancel. */
  source: 'rest' | 'mcp';
}

interface CancelJobResult {
  jobId: string;
  status: string;
  cancellationRequested: boolean;
}

export async function cancelJob(jobId: string, opts: CancelJobOptions): Promise<CancelJobResult> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw notFound('job not found');

  if (!LIVE_JOB_STATUSES.includes(job.status)) {
    throw refuseJob('NOT_CANCELLABLE', 'job is not cancellable');
  }

  const previousStatus = job.status;

  if (NO_DEVICE_STATUSES.has(job.status)) {
    const updated = await db.transaction(async (tx) => {
      const [row] = (
        await transition(tx, JOB_MACHINE, {
          to: 'cancelled',
          set: { finishedAt: new Date(), cancellationRequested: true },
          where: and(eq(jobs.id, jobId), eq(jobs.status, previousStatus)),
          reason: opts.reason,
          actor: { type: 'user', id: opts.actorUserId, agency: opts.actorAgency },
          source: 'cancel',
        })
      ).rows;
      if (!row) return null;
      await insertInterventionEvent(tx, { ...opts, ...auditFor(row, previousStatus) });
      return row;
    });
    if (!updated) {
      throw refuseJob('NOT_CANCELLABLE', 'job state changed mid-request');
    }

    await syncAgentSessionLifecycle(updated, 'cancelled');

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

  return {
    jobId: updated.id,
    status: updated.status,
    cancellationRequested: updated.cancellationRequested,
  };
}

const auditFor = (row: { id: string; issueId: string | null }, previousStatus: string) =>
  ({ jobId: row.id, issueId: row.issueId, previousStatus, action: 'cancel' }) as const;
