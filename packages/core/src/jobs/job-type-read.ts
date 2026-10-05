import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type JobType, jobs } from '../db/schema.js';

/** The job's type; null when no such job. */
export async function jobTypeOf(jobId: string): Promise<JobType | null> {
  const [row] = await db.select({ type: jobs.type }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
  return row?.type ?? null;
}
