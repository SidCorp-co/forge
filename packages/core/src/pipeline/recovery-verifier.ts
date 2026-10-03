import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus, JobType } from '../db/schema.js';
import { issues, type jobs } from '../db/schema.js';
import { ISSUE_RESOLVED_STATUSES } from '../issues/status-sets.js';

type JobRow = typeof jobs.$inferSelect;

export type RecoveryVerdict = 'advanced' | 'pending' | 'reverted';

// A job's step is progress inside `in_progress` (ISS-54), so what a job leaves behind is read off
// the statuses a run hands an issue on to: the plan checkpoint, the release gate, a park, a close.
export const JOB_TYPE_EXPECTED_EXIT_STATUS: Record<JobType, readonly IssueStatus[]> = {
  triage: ['needs_info', 'approved'],
  clarify: ['approved', 'needs_info'],
  plan: ['approved'],
  code: ['awaiting_release', 'closed'],
  review: ['awaiting_release', 'reopen'],
  test: ['awaiting_release', 'reopen'],
  staging: ['reopen'],
  fix: ['awaiting_release', 'closed'],
  release: ['awaiting_release', 'closed'],
  custom: [],
  pm: [],
  drive: [],
  // smoke canaries (ISS-455) are issue-less; there is no status to advance.
  smoke: [],
  release_batch: [],
  reconcile: [],
  verify_skill: [],
  // the onboarding analysis (ISS-63) is issue-less too.
  onboarding: [],
};

export const JOB_TYPE_ENTRY_STATUS: Partial<Record<JobType, IssueStatus>> = {
  triage: 'open',
  clarify: 'open',
  plan: 'open',
  code: 'approved',
  fix: 'reopen',
  release: 'awaiting_release',
};

// Where a step job's work stands while it runs: inside `in_progress`, whatever the step.
const JOB_TYPE_INFLIGHT_STATUS: Partial<Record<JobType, IssueStatus>> = {
  triage: 'in_progress',
  clarify: 'in_progress',
  plan: 'in_progress',
  code: 'in_progress',
  review: 'in_progress',
  test: 'in_progress',
  fix: 'in_progress',
};

export async function verifyRecovery(
  job: Pick<JobRow, 'issueId' | 'type'>,
): Promise<RecoveryVerdict> {
  if (!job.issueId) return 'pending';

  const [row] = await db
    .select({ status: issues.status })
    .from(issues)
    .where(eq(issues.id, job.issueId))
    .limit(1);

  if (!row) return 'pending';
  return classifyVerdict(row.status, job.type);
}

/**
 * Pure verdict helper exported for unit tests — no DB roundtrip.
 */
export function classifyVerdict(currentStatus: IssueStatus, jobType: JobType): RecoveryVerdict {
  const entry = JOB_TYPE_ENTRY_STATUS[jobType];
  if (entry && currentStatus === entry) return 'pending';

  // The job is still mid-flight inside `in_progress` — not advanced, not stale; the retry path
  // stays live.
  if (JOB_TYPE_INFLIGHT_STATUS[jobType] === currentStatus) return 'pending';

  const exits = JOB_TYPE_EXPECTED_EXIT_STATUS[jobType] ?? [];
  if (exits.includes(currentStatus)) return 'advanced';

  if (ISSUE_RESOLVED_STATUSES.includes(currentStatus)) return 'advanced';

  // No entry mapping (e.g. `custom` / `pm`) and not in any exit set —
  // verifier cannot decide; default to pending so the retry path proceeds.
  if (!entry) return 'pending';

  return 'reverted';
}
