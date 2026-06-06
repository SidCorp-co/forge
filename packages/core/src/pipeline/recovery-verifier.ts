/**
 * Recovery-by-verification (ISS-197).
 *
 * Before re-enqueueing a failed job, the retry engine asks the verifier
 * whether the underlying issue.status has already moved past the step the
 * failed session was driving. Three outcomes:
 *
 *   • pending  — issue is still at the entry status the job was running.
 *                Retry is meaningful; retry engine proceeds.
 *   • advanced — issue has reached one of the job's expected exit statuses
 *                or a terminal status (released/closed). The failed work
 *                has effectively been completed (manually, or by a sibling
 *                session); the retry engine marks the agent_session as
 *                `completed_via_recovery` and SKIPS the retry, saving the
 *                token cost.
 *   • reverted — issue has moved to a status owned by a different job type
 *                (e.g. failed `plan` but issue is now `developed`, which is
 *                downstream of `code`/`review`). The work is stale; the
 *                retry engine marks the session as `cancelled_stale` and
 *                SKIPS the retry — no manual_hold either.
 *
 * Pure read-only: a single SELECT against issues.status. No writes. The
 * retry engine owns the resulting session terminal-state write.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus, JobType } from '../db/schema.js';
import { issues, type jobs } from '../db/schema.js';

type JobRow = typeof jobs.$inferSelect;

export type RecoveryVerdict = 'advanced' | 'pending' | 'reverted';

/**
 * Statuses an issue may legitimately occupy immediately after the named
 * job type completes successfully. A job whose issue is now in one of its
 * exit statuses is considered `advanced`.
 *
 * The map is derived from PIPELINE_STEPS in `registry.ts` plus the
 * branching exits each step can take (triage → needs_info OR confirmed;
 * review/test → testing OR reopen on failure).
 */
export const JOB_TYPE_EXPECTED_EXIT_STATUS: Record<JobType, readonly IssueStatus[]> = {
  triage: ['needs_info', 'confirmed'],
  clarify: ['clarified', 'needs_info'],
  plan: ['approved'],
  code: ['developed'],
  review: ['testing', 'reopen'],
  test: ['released', 'reopen', 'tested', 'pass'],
  fix: ['developed'],
  release: ['released', 'closed'],
  custom: [],
  pm: [],
};

/** Statuses the issue has nothing left to do on; any failed job lands here as
 * `advanced` — the retry no longer matters. */
const TERMINAL_STATUSES: ReadonlySet<IssueStatus> = new Set(['released', 'closed']);

/**
 * Entry status for a given job type (i.e. the issue.status whose pipeline
 * step dispatches this jobType). Mirrors PIPELINE_STEPS without re-importing
 * the const so the verifier stays decoupled from registry layout changes;
 * the registry test asserts the mapping stays in sync.
 */
export const JOB_TYPE_ENTRY_STATUS: Partial<Record<JobType, IssueStatus>> = {
  triage: 'open',
  clarify: 'confirmed',
  plan: 'clarified',
  code: 'approved',
  review: 'developed',
  test: 'testing',
  fix: 'reopen',
  release: 'released',
};

/**
 * In-flight marker a job moves the issue to WHILE it runs (ISS-393). `code`
 * and `fix` flip the issue to `in_progress` at `forge_step_start`; the issue
 * is therefore neither at its entry status nor at any exit status while the
 * job is mid-flight. Without this map `classifyVerdict('in_progress','code')`
 * returns `reverted` → the retry engine marks the session `cancelled_stale`
 * and SKIPS the retry → a code/fix failure no-ops (the ISS-34 wedge). Treating
 * the in-flight marker as `pending` keeps the retry path live. Other job types
 * keep their entry status for the whole job, so they need no entry here.
 */
const JOB_TYPE_INFLIGHT_STATUS: Partial<Record<JobType, IssueStatus>> = {
  code: 'in_progress',
  fix: 'in_progress',
};

/**
 * Compute the verdict for a single failed job. Returns 'pending' when the
 * verifier cannot make a confident judgment (no issue, missing entry
 * mapping) so the caller stays on the retry path rather than silently
 * dropping work.
 */
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
