import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { withKernelMarker } from '../db/kernel-marker.js';
import { jobs } from '../db/schema.js';
import { publishPipelineHealthChanged } from '../issues/pipeline-health.js';
import { logger } from '../logger.js';
import { answeredRequeue } from '../release-batch/decision-hold.js';
import { readDecisionQuestions, readDecisionRef } from '../release-batch/decision-state.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { buildRequeueUpdate, dispatchRequeuedJob, readHoldState } from './hold.js';
import { insertInterventionEvent } from './intervention-event.js';

export class JobResumeError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'NOT_HELD' | 'DECISION_OPEN',
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

  let requeue: ReturnType<typeof buildRequeueUpdate> | null = null;
  const decision = readDecisionRef(job.id, job.payload);
  if (decision && !decision.answeredAt) {
    const open = (await readDecisionQuestions(decision.questionIds)).filter(
      (q) => q.status === 'open',
    );
    if (open.length > 0) {
      throw new JobResumeError(
        'DECISION_OPEN',
        `this job waits on ${open.length} open question${open.length === 1 ? '' : 's'} (${open.map((q) => q.id).join(', ')}): answer ${open.length === 1 ? 'it' : 'them'}, and the job goes on by itself, or abort the release it belongs to`,
      );
    }
    requeue = await answeredRequeue(job, decision);
  }

  const heldReason = readHoldState(job.payload)?.reason ?? job.failureReason ?? null;

  const updated = await withKernelMarker(db, async (tx) => {
    const [row] = await tx
      .update(jobs)
      .set(requeue ?? buildRequeueUpdate(job, new Date()))
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
