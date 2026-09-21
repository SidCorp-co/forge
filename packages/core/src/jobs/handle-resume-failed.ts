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
