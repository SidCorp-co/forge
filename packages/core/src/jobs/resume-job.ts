/**
 * The operator's half of the hold path: put a `held` job back in the queue.
 *
 * Two of the five hold reasons name a condition no code can re-check
 * (`retry_rounds_exhausted`, `non_retryable_terminal`), so `releaseHeldJobs`
 * correctly refuses to touch them — they wait for a human. Until now nothing
 * let that human act: `held` was cancellable and nothing else, so the only way
 * out of a hold whose cause had been FIXED was to kill the step. Measured on
 * forge-beta 2026-08-14: 18 held jobs across 4 projects, aged 5.7–9.2h, every
 * one of them under a still-`running` run that INV-4 forbids closing while the
 * hold stands.
 *
 * The operator's assertion that the cause is gone IS the condition check those
 * two reasons lack. That is why this is an audited intervention and not a
 * sweeper pass.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { publishPipelineHealthChanged } from '../issues/pipeline-health.js';
import { logger } from '../logger.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { buildRequeueUpdate, dispatchRequeuedJob, readHoldState } from './hold.js';
import { insertInterventionEvent } from './intervention-event.js';

/**
 * Transport-neutral failure raised by {@link resumeHeldJob}. Callers map `code`
 * to their own surface: REST → HTTP 404/409, MCP → `Error('CODE: message')`.
 */
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
// cm:guard resume must go through `buildRequeueUpdate`, never its own UPDATE — the row a resumed job produces has to be byte-identical to a self-released one, or `releaseHeldJobs`' once-per-lineage bound applies to one path and not the other and a resumed job quietly earns extra auto-releases
// cm:guard the CAS on `status='held'` is the whole concurrency story — two operators pressing resume, or a resume racing `releaseHeldJobs`, must not both enqueue. The second UPDATE matches no row and this throws NOT_HELD, which is the honest answer.
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

  const updated = await db.transaction(async (tx) => {
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

  // cm:guard dispatch AFTER the commit — `dispatchRequeuedJob` enqueues, and an enqueue inside the transaction can hand the dispatcher a job id that a rollback then makes nonexistent
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
