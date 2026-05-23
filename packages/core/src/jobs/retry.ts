/**
 * Narrow auto-retry semantic — replaces the legacy exponential-backoff chain.
 *
 * Old model: 3 attempts with `60 * 2^n` backoff regardless of classification,
 * coupled with a second tier of issue-level recovery in pipeline-sweeper.
 * Result: failures burned 3-6 retries before the operator was notified.
 *
 * New model: AT MOST ONE auto-retry, gated on a narrow classifier whitelist
 * (transient network errors only — HTTP 5xx, 429, ECONNRESET, timeout, etc).
 * Everything else returns `{ scheduled: false }` immediately so the caller
 * (lifecycle / watchdog / dispatcher) can hand off to setManualHoldBlock.
 *
 * No exponential backoff: the classifier already filters for genuine
 * transients, so a flat 60s cooldown is plenty.
 */

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
  reason?: string;
}

/** Hard cap: 1 auto-retry per original job. Operator-driven retry is unbounded. */
const MAX_AUTO_RETRIES = 1;

/** Cooldown before the auto-retry fires. Transient network blips usually
 *  recover within a minute; longer waits indicate something the operator
 *  should look at anyway. */
const AUTO_RETRY_COOLDOWN_SECONDS = 60;

/**
 * Schedule a single auto-retry for a failed job IF the classifier says the
 * failure is transient. Returns `{ scheduled: false, reason }` for everything
 * else — the caller is expected to then call `setManualHoldBlock` to surface
 * the failure to the operator.
 *
 * Idempotent: a second call on a job that already had its one retry returns
 * `{ scheduled: false, reason: 'retry_budget_exhausted' }`.
 */
export async function scheduleAutoRetryOnce(
  job: JobRow,
  reason: string,
): Promise<RetryOutcome> {
  if (job.cancellationRequested) {
    return { scheduled: false, reason: 'cancellation_requested' };
  }

  const inputError =
    typeof job.error === 'string' && job.error.length > 0 ? job.error : reason;
  const classified = classifyFailure({ error: inputError });

  // Persist classification on the failed job for the audit trail / operator
  // UI, even when we decide not to retry. Done in a try/catch so a classifier
  // write failure can't break the retry path.
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

  if (classified.kind !== 'transient') {
    logger.info(
      { jobId: job.id, kind: classified.kind, classifierVersion: CLASSIFIER_VERSION },
      'retry: not transient, no auto-retry',
    );
    return { scheduled: false, reason: `classifier:${classified.kind}` };
  }

  if (job.attempts >= MAX_AUTO_RETRIES + 1) {
    logger.info(
      { jobId: job.id, attempts: job.attempts, reason },
      'retry: auto-retry budget exhausted',
    );
    return { scheduled: false, reason: 'retry_budget_exhausted' };
  }

  const [created] = await db
    .insert(jobs)
    .values({
      projectId: job.projectId,
      issueId: job.issueId,
      pipelineRunId: job.pipelineRunId,
      createdBy: job.createdBy,
      type: job.type,
      payload: job.payload,
      modelTier: job.modelTier,
      status: 'queued',
      attempts: job.attempts + 1,
      retryOf: job.id,
    })
    .returning({ id: jobs.id });

  if (!created) throw new Error('retry: insert returned no row');

  try {
    await enqueueJob(
      { jobId: created.id, issueId: job.issueId, type: job.type },
      { startAfterSeconds: AUTO_RETRY_COOLDOWN_SECONDS },
    );
  } catch (err) {
    logger.error({ err, jobId: created.id }, 'retry: enqueue failed; row persisted');
  }

  logger.info(
    {
      originalJobId: job.id,
      newJobId: created.id,
      cooldownSec: AUTO_RETRY_COOLDOWN_SECONDS,
      reason,
    },
    'retry: auto-retry scheduled',
  );

  return { scheduled: true, newJobId: created.id };
}
