import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { logger } from '../logger.js';
import { enqueueJob } from './enqueue.js';

type JobRow = typeof jobs.$inferSelect;

export interface RetryOutcome {
  scheduled: boolean;
  newJobId?: string;
  attempt?: number;
  backoffSec?: number;
}

export function computeBackoffSeconds(attempts: number): number {
  return 60 * 2 ** attempts;
}

/**
 * Schedule a retry for a failed job.
 *
 * Creates a NEW `jobs` row (immutable attempt history) with `attempts+1`,
 * `retry_of` pointing at the original, and enqueues via pg-boss with
 * `startAfter: backoffSec`. Returns `{ scheduled: false }` if the retry cap
 * is reached or the job was cancelled — cancellation is never retried.
 */
export async function scheduleRetry(job: JobRow, reason: string): Promise<RetryOutcome> {
  if (job.status === 'cancelled') {
    return { scheduled: false };
  }
  if (job.attempts >= job.maxAttempts) {
    logger.info(
      { jobId: job.id, attempts: job.attempts, maxAttempts: job.maxAttempts, reason },
      'retry: cap reached',
    );
    return { scheduled: false };
  }

  const backoffSec = computeBackoffSeconds(job.attempts);
  const nextAttempt = job.attempts + 1;

  const [created] = await db
    .insert(jobs)
    .values({
      projectId: job.projectId,
      issueId: job.issueId,
      createdBy: job.createdBy,
      type: job.type,
      payload: job.payload,
      modelTier: job.modelTier,
      status: 'queued',
      attempts: nextAttempt,
      maxAttempts: job.maxAttempts,
      retryOf: job.id,
    })
    .returning({ id: jobs.id });

  if (!created) throw new Error('retry: insert returned no row');

  try {
    await enqueueJob(created.id, { startAfterSeconds: backoffSec });
  } catch (err) {
    logger.error({ err, jobId: created.id }, 'retry: enqueue failed; row persisted');
  }

  logger.info(
    { originalJobId: job.id, newJobId: created.id, attempt: nextAttempt, backoffSec, reason },
    'retry: scheduled',
  );

  return { scheduled: true, newJobId: created.id, attempt: nextAttempt, backoffSec };
}
