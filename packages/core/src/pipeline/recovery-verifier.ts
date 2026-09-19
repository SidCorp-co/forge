import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus, JobType } from '../db/schema.js';
import { issues, type jobs } from '../db/schema.js';

type JobRow = typeof jobs.$inferSelect;

export type RecoveryVerdict = 'advanced' | 'pending' | 'reverted';

export const JOB_TYPE_EXPECTED_EXIT_STATUS: Record<JobType, readonly IssueStatus[]> = {
  triage: ['needs_info', 'confirmed'],
  clarify: ['clarified', 'needs_info'],
  plan: ['approved'],
  code: ['developed'],
  review: ['testing', 'reopen'],
  test: ['awaiting_release', 'reopen', 'tested'],
  staging: ['reopen'],
  fix: ['developed'],
  release: ['awaiting_release', 'closed'],
  custom: [],
  pm: [],
  drive: [],
  // smoke canaries (ISS-455) are issue-less; there is no status to advance.
  smoke: [],
  release_batch: [],
  reconcile: [],
  verify_skill: [],
};

/** Statuses the issue has nothing left to do on; any failed job lands here as
 * `advanced` — the retry no longer matters. */
const TERMINAL_STATUSES: ReadonlySet<IssueStatus> = new Set(['awaiting_release', 'closed']);

export const JOB_TYPE_ENTRY_STATUS: Partial<Record<JobType, IssueStatus>> = {
  triage: 'open',
  clarify: 'confirmed',
  plan: 'clarified',
  code: 'approved',
  review: 'developed',
  test: 'testing',
  fix: 'reopen',
  release: 'awaiting_release',
};

const JOB_TYPE_INFLIGHT_STATUS: Partial<Record<JobType, IssueStatus>> = {
  code: 'in_progress',
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

  // The job is still mid-flight at its in-flight marker (code/fix →
  // in_progress) — not advanced, not stale; the retry path stays live.
  if (JOB_TYPE_INFLIGHT_STATUS[jobType] === currentStatus) return 'pending';

  const exits = JOB_TYPE_EXPECTED_EXIT_STATUS[jobType] ?? [];
  if (exits.includes(currentStatus)) return 'advanced';

  if (TERMINAL_STATUSES.has(currentStatus)) return 'advanced';

  // No entry mapping (e.g. `custom` / `pm`) and not in any exit set —
  // verifier cannot decide; default to pending so the retry path proceeds.
  if (!entry) return 'pending';

  return 'reverted';
}
