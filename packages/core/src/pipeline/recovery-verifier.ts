import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, type jobs } from '../db/schema.js';
import { ISSUE_RESOLVED_STATUSES } from '../issues/status-sets.js';

type JobRow = typeof jobs.$inferSelect;

export type RecoveryVerdict = 'advanced' | 'pending';

/**
 * Whether a failed job's issue already finished, so retrying the job would redo shipped work.
 * No live job type has a stage status to read beyond that (ISS-1229).
 */
export async function verifyRecovery(job: Pick<JobRow, 'issueId'>): Promise<RecoveryVerdict> {
  if (!job.issueId) return 'pending';

  const [row] = await db
    .select({ status: issues.status })
    .from(issues)
    .where(eq(issues.id, job.issueId))
    .limit(1);

  if (!row) return 'pending';
  return ISSUE_RESOLVED_STATUSES.includes(row.status) ? 'advanced' : 'pending';
}
