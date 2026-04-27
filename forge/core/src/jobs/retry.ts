import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { logger } from '../logger.js';
import { CLASSIFIER_VERSION, classifyFailure } from '../pipeline/failure-classifier.js';
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

  // Persist a classification on the parent job before deciding. The
  // sweeper reads `failure_kind` to choose recover vs escalate; the
  // attempt cap below also short-circuits permanent failures so we do
  // not waste API budget retrying a deterministic policy block (e.g.
  // Anthropic content filter).
  const inputError =
    typeof job.error === 'string' && job.error.length > 0 ? job.error : reason;
  const classified = classifyFailure({ error: inputError });
  if (job.failureKind === null || job.failureKind === undefined) {
    try {
      await db
        .update(jobs)
        .set({
          failureKind: classified.kind,
          failureReason: classified.reason,
          failureMeta: classified.meta as never,
          classifierVersion: classified.version,
        })
        .where(eq(jobs.id, job.id));
      // Mirror onto the in-memory row so downstream readers see it.
      job.failureKind = classified.kind;
      job.failureReason = classified.reason;
      job.classifierVersion = classified.version;
    } catch (err) {
      logger.warn(
        { err, jobId: job.id },
        'retry: failed to persist classification, continuing',
      );
    }
  }

  if (classified.kind === 'permanent') {
    logger.info(
      { jobId: job.id, reason: classified.reason, classifierVersion: CLASSIFIER_VERSION },
      'retry: skipping retry on permanent failure',
    );
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
