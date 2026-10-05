/**
 * A runner reporting that its job failed: `/fail`. The route owns
 * the device and state guards; this owns the transition and every side effect
 * that follows it, in the order the finish has always run them.
 */

import { settleTranscriptAndUsage } from './finalize-done.js';
import { finalizeFailedJob } from './finalize-failure.js';
import { isResumeFailedError, reclassifyAbortedResume } from './handle-resume-failed.js';
import type { JobGateRow } from './job-queries.js';
import { type SalvageRecord, salvageSet } from './prior-attempts.js';
import { refuseJob } from './refusals.js';
import { finishJobFromRunner } from './service.js';

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
  // ISS-280 / ISS-393: an aborted resume is reclassified before the retry decision.
  const row = isResumeFailedError(input.error) ? await reclassifyAbortedResume(updated) : updated;
  const retry = await finalizeFailedJob(row, { error: input.error });
  return { jobId: row.id, status: row.status, error: row.error, retry };
}
