/**
 * A runner reporting how its job ended: `/complete` and `/fail`. The route owns
 * the device and state guards; this owns the transition and every side effect
 * that follows it, in the order the finish has always run them.
 */

import type { jobs } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { publishFinished, settleTranscriptAndUsage } from './finalize-done.js';
import { finalizeFailedJob } from './finalize-failure.js';
import { isResumeFailedError, reclassifyAbortedResume } from './handle-resume-failed.js';
import type { JobGateRow } from './job-queries.js';
import { type SalvageRecord, salvageSet } from './prior-attempts.js';
import { refuseJob } from './refusals.js';
import { finishJobFromRunner, reclaimReapedJob } from './service.js';

type JobRow = typeof jobs.$inferSelect;

/**
 * ISS-378 — idempotent late completion. A runner that finished real work but
 * whose /complete was lost to a core outage finds its job already reaped to
 * `failed` by a timeout/orphan sweep. If no retry attempt has taken over, the
 * success is accepted (failed→done plus the success side effects) instead of
 * 409-discarding real work (ISS-360 lost a merged PR this way). Null when a
 * retry descendant owns the outcome.
 */
export async function reconcileLateCompletion(
  job: JobGateRow & { error: string },
  deviceId: string,
) {
  const reclaimed = await reclaimReapedJob(job, deviceId);
  if (!reclaimed) return null;
  logger.warn(
    { jobId: reclaimed.id, reapedError: job.error },
    'lifecycle: reconciled a late successful completion — job had been reaped (work would otherwise be lost)',
  );
  settleTranscriptAndUsage(reclaimed);
  await publishFinished(reclaimed, 'done', 0);
  return { jobId: reclaimed.id, status: 'done', exitCode: 0, retry: null, reconciled: true };
}

/** ISS-280 / ISS-393 — the shared finalize path after a runner-reported failure. */
async function finalizeRunnerFailure(updated: JobRow, error: string, exitCode?: number) {
  const row = isResumeFailedError(error) ? await reclassifyAbortedResume(updated) : updated;
  const retry = await finalizeFailedJob(row, {
    error,
    ...(exitCode !== undefined ? { exitCode } : {}),
  });
  return { row, retry };
}

export async function completeJobFromRunner(
  job: JobGateRow,
  input: { exitCode: number; error?: string | null | undefined },
  deviceId: string,
) {
  const status: 'done' | 'cancelled' | 'failed' =
    input.exitCode === 0 ? 'done' : input.exitCode === -1 ? 'cancelled' : 'failed';
  const effectiveError: string | null = input.error ?? null;
  const updated = await finishJobFromRunner({
    jobId: job.id,
    from: job.status,
    to: status,
    set: { exitCode: input.exitCode, error: effectiveError, finishedAt: new Date() },
    reason: status === 'failed' ? (effectiveError ?? 'exit nonzero') : `lifecycle_${status}`,
    deviceId,
  });
  if (!updated) throw refuseJob('INVALID_STATE', 'job state changed mid-request');
  settleTranscriptAndUsage(updated);

  if (status === 'failed') {
    const { row, retry } = await finalizeRunnerFailure(
      updated,
      effectiveError ?? 'exit nonzero',
      input.exitCode,
    );
    return { jobId: row.id, status: row.status, exitCode: row.exitCode, retry };
  }
  await publishFinished(updated, status, updated.exitCode);
  return { jobId: updated.id, status: updated.status, exitCode: updated.exitCode, retry: null };
}

export async function failJobFromRunner(
  job: JobGateRow,
  input: { error: string; salvage?: SalvageRecord | undefined },
  deviceId: string,
) {
  const updated = await finishJobFromRunner({
    jobId: job.id,
    from: job.status,
    to: 'failed',
    set: { error: input.error, finishedAt: new Date(), ...salvageSet(input.salvage) },
    reason: input.error,
    deviceId,
  });
  if (!updated) throw refuseJob('INVALID_STATE', 'job state changed mid-request');
  settleTranscriptAndUsage(updated);
  const { row, retry } = await finalizeRunnerFailure(updated, input.error);
  return { jobId: row.id, status: row.status, error: row.error, retry };
}
