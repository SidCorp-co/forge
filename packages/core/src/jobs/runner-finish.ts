/**
 * A runner reporting that its job failed: `/fail`. The route owns
 * the device and state guards; this owns the transition and every side effect
 * that follows it, in the order the finish has always run them.
 */

import { settleConfirmedCancel } from './cancel-job.js';
import { settleTranscriptAndUsage } from './finalize-done.js';
import { finalizeFailedJob } from './finalize-failure.js';
import { isResumeFailedError, reclassifyAbortedResume } from './handle-resume-failed.js';
import type { JobGateRow } from './job-queries.js';
import { scrubJobOutput } from './job-secret-scrub.js';
import { type SalvageRecord, salvageSet } from './prior-attempts.js';
import { refuseJob } from './refusals.js';
import type { RetryOutcome } from './retry.js';
import { finishJobFromRunner } from './service.js';

export async function failJobFromRunner(
  job: JobGateRow,
  input: { error: string; salvage?: SalvageRecord | undefined },
  deviceId: string,
) {
  const error = await scrubJobOutput([job.id], input.error);
  // A person asked to cancel this job, and its box has ended its work on it however that came
  // about: that is the cancel taking effect, not a failure to retry. The box reports before it
  // closes the pane (`pool_jobs::conclude`), so a pane that will not close outlives this answer
  // under a terminal job, as it does under `failed`, and the box closes it at its next tick.
  if (job.cancellationRequested) {
    const cancelled = await settleConfirmedCancel({
      jobId: job.id,
      deviceId,
      reason: `cancel taken: the runner reported the job over (${error})`,
      error,
    });
    if (!cancelled) throw refuseJob('INVALID_STATE', 'job state changed mid-request');
    settleTranscriptAndUsage(cancelled);
    const retry: RetryOutcome = { scheduled: false, reason: 'cancellation_requested' };
    return { jobId: cancelled.id, status: cancelled.status, error: cancelled.error, retry };
  }
  const updated = await finishJobFromRunner({
    jobId: job.id,
    from: job.status,
    to: 'failed',
    set: { error, finishedAt: new Date(), ...salvageSet(input.salvage) },
    reason: error,
    deviceId,
  });
  if (!updated) throw refuseJob('INVALID_STATE', 'job state changed mid-request');
  settleTranscriptAndUsage(updated);
  // ISS-280 / ISS-393: an aborted resume is reclassified before the retry decision.
  const row = isResumeFailedError(error) ? await reclassifyAbortedResume(updated) : updated;
  const retry = await finalizeFailedJob(row, { error });
  return { jobId: row.id, status: row.status, error: row.error, retry };
}
