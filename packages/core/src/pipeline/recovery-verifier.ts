import { ISSUE_RESOLVED_STATUSES } from '@forge/contracts/issue-machine';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { issues, type jobs } from '../db/schema.js';

type JobRow = typeof jobs.$inferSelect;

type RecoveryVerdict = 'advanced' | 'pending';

export async function verifyRecovery(job: Pick<JobRow, 'issueId'>): Promise<RecoveryVerdict> {
  if (!job.issueId) return 'pending';

  const [row] = await db
    .select({ status: issues.status })
    .from(issues)
    .where(eq(issues.id, job.issueId))
    .limit(1);

  if (!row) return 'pending';
  return classifyVerdict(row.status);
}

// No mintable job type names a step status of its own, so the only progress a failed job can have
// left behind is an issue that was resolved under it.
function classifyVerdict(currentStatus: IssueStatus): RecoveryVerdict {
  return ISSUE_RESOLVED_STATUSES.includes(currentStatus) ? 'advanced' : 'pending';
}
