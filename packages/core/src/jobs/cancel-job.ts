import { JOB_MACHINE, LIVE_JOB_STATUSES } from '@forge/contracts/job-machine';
import type { ActorAgency } from '@forge/contracts/permissions';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { publishPipelineHealthChanged } from '../issues/index.js';
import { transition } from '../lifecycle/index.js';
import { notFound } from '../middleware/route-errors.js';
import { syncAgentSessionLifecycle } from './agent-session-link.js';
import { insertInterventionEvent } from './intervention-event.js';
import { pushJobCancel, pushJobChanged } from './job-push.js';
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

    await announceCancelled(updated);

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
    await pushJobCancel(
      { id: updated.id, projectId: updated.projectId, deviceId: updated.deviceId },
      { jobId: updated.id, projectId: updated.projectId },
    );
  }
  await pushJobChanged(updated, 'job.cancelRequested', {
    jobId: updated.id,
    projectId: updated.projectId,
  });

  return {
    jobId: updated.id,
    status: updated.status,
    cancellationRequested: updated.cancellationRequested,
  };
}

type JobRow = typeof jobs.$inferSelect;

/** What a job ending `cancelled` owes everyone else: its session, its watchers, its issue's health. */
async function announceCancelled(row: JobRow): Promise<void> {
  await syncAgentSessionLifecycle(row, 'cancelled');
  await pushJobChanged(row, 'job.cancelled', {
    jobId: row.id,
    projectId: row.projectId,
    status: 'cancelled',
  });
  if (row.issueId) await publishPipelineHealthChanged(row.projectId, [row.issueId]);
}

/**
 * A dispatched job a person asked to cancel, settled `cancelled` once the box it was dispatched
 * to says its process is over: a kill-ack `killed`, or a failure report. Until then the job stays
 * `dispatched`, because its process may still be running. Answers the settled row, or null where
 * the job is not a dispatched, cancel-requested job on `deviceId` — which the caller's own path
 * then answers.
 */
export async function settleConfirmedCancel(args: {
  jobId: string;
  deviceId: string;
  reason: string;
  error?: string;
}): Promise<JobRow | null> {
  const [row] = (
    await transition(db, JOB_MACHINE, {
      to: 'cancelled',
      from: 'dispatched',
      set: { finishedAt: new Date(), ...(args.error === undefined ? {} : { error: args.error }) },
      where: and(
        eq(jobs.id, args.jobId),
        eq(jobs.deviceId, args.deviceId),
        eq(jobs.cancellationRequested, true),
      ),
      reason: args.reason,
      actor: { type: 'runner', id: args.deviceId },
      source: 'cancel',
    })
  ).rows;
  if (!row) return null;
  await announceCancelled(row);
  return row;
}

const auditFor = (row: { id: string; issueId: string | null }, previousStatus: string) =>
  ({ jobId: row.id, issueId: row.issueId, previousStatus, action: 'cancel' }) as const;
