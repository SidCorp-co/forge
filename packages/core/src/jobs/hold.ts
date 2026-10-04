import {
  AUTO_RELEASE_REASONS,
  HOLD_PAYLOAD_KEY,
  type HoldState,
  readHoldState,
  TIME_CHECKED_REASONS,
} from '@forge/contracts/jobs';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { logger } from '../observability/logger.js';

export {
  AUTO_RELEASE_REASONS,
  HOLD_PAYLOAD_KEY,
  type HoldState,
  holdReleasesItself,
  readHoldState,
} from '@forge/contracts/jobs';

type JobRow = typeof jobs.$inferSelect;

const HOLD_REASONS: ReadonlySet<string> = new Set([
  'all_devices_exhausted',
  'retry_rounds_exhausted',
  'non_retryable_terminal',
  'verify_unavailable',
]);

/** How long a {@link TIME_CHECKED_REASONS} hold waits before it tries again. */
const HOLD_RECHECK_MS = 10 * 60_000;

/**
 * Whether holding `job` for `reason` produces a hold that will release itself: a self-clearing
 * reason on a lineage that has not been held before, so a re-hold answers false.
 */
export function holdAutoReleases(priorPayload: unknown, reason: string): boolean {
  return readHoldState(priorPayload) === null && AUTO_RELEASE_REASONS.has(reason);
}

/**
 * Insert the held successor for a job whose retries are spent: its id, or `null` for a reason
 * that is not a hold reason or an insert `jobs_active_unique` refused to a concurrent active job.
 */
export async function holdJobForReason(job: JobRow, reason: string): Promise<string | null> {
  if (!HOLD_REASONS.has(reason)) return null;

  const state: HoldState = {
    reason,
    heldAt: new Date().toISOString(),
    autoRelease: holdAutoReleases(job.payload, reason),
  };
  const basePayload = (job.payload ?? {}) as Record<string, unknown>;
  const retryAfterAt = TIME_CHECKED_REASONS.has(reason)
    ? new Date(Date.now() + HOLD_RECHECK_MS)
    : null;

  try {
    const [created] = await db
      .insert(jobs)
      .values({
        projectId: job.projectId,
        issueId: job.issueId,
        pipelineRunId: job.pipelineRunId,
        createdBy: job.createdBy,
        type: job.type,
        payload: { ...basePayload, [HOLD_PAYLOAD_KEY]: state },
        modelTier: job.modelTier,
        status: 'held',
        attempts: job.attempts,
        retryOf: job.id,
        failureReason: reason,
        ...(retryAfterAt ? { retryAfterAt } : {}),
      })
      .returning({ id: jobs.id });
    if (!created) return null;
    logger.info(
      { jobId: created.id, heldFrom: job.id, issueId: job.issueId, ...state },
      'hold: job held',
    );
    return created.id;
  } catch (err) {
    logger.warn({ err, jobId: job.id, reason }, 'hold: successor insert failed');
    return null;
  }
}
