// The runner tags a resume failure with `[RESUME_FAILED]` (`claude_code.rs`)
// when claude exits on "session not found" / "could not resume". A tagged
// failure is reclassified so the retry chain reads it as a code failure
// rather than an infrastructure one.
//
// cm:why the `onResumeFail` policy and the prior-session invalidation that used to live here went with `sessionGroups` (ISS-897): both keyed on `payload.sessionGroup`, which has had no producer since `states[x].sessionGroup` left the config schema. A retry still resumes through its parent attempt (`jobs/resume-policy.ts`), and that path never needed either.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { CLASSIFIER_VERSION } from '../pipeline/failure-classifier.js';

const RESUME_TAG = '[RESUME_FAILED]';

/**
 * Reclassify an aborted resume, returning the updated row (or the one passed in, when the write
 * found nothing). Both lifecycle paths call this so they cannot drift on the version stamp.
 */
export async function reclassifyAbortedResume<T extends { id: string }>(job: T): Promise<T> {
  const [reclassified] = await db
    .update(jobs)
    .set({
      failureReason: 'resume_failed',
      failureKind: 'code',
      classifierVersion: CLASSIFIER_VERSION,
    })
    .where(eq(jobs.id, job.id))
    .returning();
  return (reclassified as T | undefined) ?? job;
}

export function isResumeFailedError(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.startsWith(RESUME_TAG);
}
