import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { withKernelMarker } from '../db/kernel-marker.js';
import { jobs } from '../db/schema.js';
import { publishPipelineHealthChanged } from '../issues/pipeline-health.js';
import { logger } from '../logger.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { buildRequeueUpdate, dispatchRequeuedJob, readHoldState } from './hold.js';
import { insertInterventionEvent } from './intervention-event.js';

export class JobResumeError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'NOT_HELD',
    message: string,
  ) {
    super(message);
    this.name = 'JobResumeError';
  }
}

export interface ResumeJobOptions {
  /** User id of the acting principal — recorded in the audit event. */
  actorUserId: string;
  /** Human-supplied reason — recorded in the audit event. */
  reason: string;
  /** Which surface invoked the resume. */
  source: 'rest' | 'mcp';
}

export interface ResumeJobResult {
  jobId: string;
  status: string;
  /** The reason it was holding, so the caller can echo what it just overrode. */
  heldReason: string | null;
}

/**
 * Flip one `held` job back to `queued` and dispatch it.
 *
 * Deliberately does NOT re-run the hold's condition check: a resume is the
 * operator overriding it. The audit row is what makes that override reviewable.
 *
 * @throws {JobResumeError} `NOT_FOUND` if the job does not exist; `NOT_HELD` if
 *   it is in any other status (or the CAS lost a race).
 */
export async function resumeHeldJob(
  jobId: string,
  opts: ResumeJobOptions,
): Promise<ResumeJobResult> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw new JobResumeError('NOT_FOUND', 'job not found');
  if (job.status !== 'held') {
    throw new JobResumeError('NOT_HELD', `job is ${job.status}, not held`);
  }

  const heldReason = readHoldState(job.payload)?.reason ?? job.failureReason ?? null;

  const updated = await withKernelMarker(db, async (tx) => {
    const [row] = await tx
      .update(jobs)
      .set(buildRequeueUpdate(job, new Date()))
      .where(and(eq(jobs.id, jobId), eq(jobs.status, 'held')))
      .returning({ id: jobs.id, type: jobs.type, issueId: jobs.issueId });
    if (!row) return null;
    await insertInterventionEvent(tx, {
      ...opts,
      jobId: row.id,
      issueId: row.issueId,
      previousStatus: 'held',
      action: 'resume',
    });
    return row;
  });
  if (!updated) throw new JobResumeError('NOT_HELD', 'job state changed mid-request');

  logger.info({ jobId, issueId: updated.issueId, heldReason }, 'resume: held job re-queued');

  await dispatchRequeuedJob(updated);

  roomManager.publish(projectRoom(job.projectId), {
    event: 'job.resumed',
    data: { jobId: updated.id, status: 'queued' },
  });
  if (updated.issueId) {
    await publishPipelineHealthChanged(job.projectId, [updated.issueId]);
  }

  return { jobId: updated.id, status: 'queued', heldReason };
}
