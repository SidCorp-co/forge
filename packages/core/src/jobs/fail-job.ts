import { and, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { type JobStatus, type jobs, jobs as jobsTable } from '../db/schema.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { materializeJobUsage } from '../usage-records/materialize.js';
import { type FinalizeFailedJobOptions, finalizeFailedJob } from './finalize-failure.js';
import { isResumeFailedError, reclassifyAbortedResume } from './handle-resume-failed.js';
import { type SalvageRecord, salvageSet } from './prior-attempts.js';
import type { RetryOutcome } from './retry.js';
import { deriveSessionFinal } from './session-transcript.js';

type JobRow = typeof jobs.$inferSelect;

/**
 * Fail a job that is out with a box, on that box's word: the transition, the final transcript
 * derivation and usage, then the shared finalize (retry, parks, hooks). What the finalize does about
 * a retry or about the run is `finalize`'s to say, for a caller that has already decided.
 */
export async function failOccupyingJob(
  job: { id: string; status: JobStatus },
  deviceId: string,
  input: { error: string; salvage?: SalvageRecord | undefined; failureReason?: string | undefined },
  finalize: Pick<FinalizeFailedJobOptions, 'precomputedRetry' | 'runContinues'> = {},
): Promise<{ updated: JobRow; retry: RetryOutcome }> {
  let [updated] = await applyKernelTransition(db, {
    entity: 'job',
    to: 'failed',
    set: {
      error: input.error,
      finishedAt: new Date(),
      ...salvageSet(input.salvage),
      // A cause the caller knows is recorded with the failure, so no reader takes it as unclassified.
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
    },
    where: and(eq(jobsTable.id, job.id), eq(jobsTable.status, job.status)),
    fromStatus: job.status,
    reason: input.error,
    actor: { type: 'runner', id: deviceId },
    source: 'lifecycle',
  });

  if (!updated) {
    throw new HTTPException(409, {
      message: 'job state changed mid-request',
      cause: { code: 'INVALID_STATE' },
    });
  }

  // Final transcript derive (see `/complete`). Fire-and-forget.
  if (updated.agentSessionId) {
    void deriveSessionFinal(updated.id, updated.agentSessionId);
  }
  void materializeJobUsage(updated);

  if (isResumeFailedError(input.error)) {
    updated = await reclassifyAbortedResume(updated);
  }

  const retry = await finalizeFailedJob(updated, { error: input.error, ...finalize });
  return { updated, retry };
}
