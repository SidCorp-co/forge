/**
 * ISS-232, ISS-1073 — the close's stamp, and the status the merge state is
 * anchored on.
 *
 * The picker's L2 gate asks "is the parent's `merged_at` NULL?" rather than "is
 * the parent's status in (released, closed)?" — status does not carry merge
 * state for trunk-based repos.
 *
 * ## What used to be here
 *
 * `markMergedIfLeavingBase` stamped on every transition out of
 * {@link BASE_MERGE_STATE}. ISS-1073 deleted it rather than narrowing it, and
 * the reason is the status ladder: `issueStatuses` holds no `released`, so the
 * hop runs `awaiting_release -> releasing -> closed` and the writer already
 * returned early for `releasing` and `dropped`. That left exactly one forward
 * hop it stamped on — `awaiting_release -> closed` — which
 * {@link markMergedOnClose} stamps on inside the same transaction, and a dozen
 * BACKWARD hops it also stamped on: `awaiting_release -> waiting`,
 * `-> reopen`, `-> on_hold`, `-> needs_info`, `-> in_progress`. An issue sent
 * back from the release gate is not an issue that landed. Its whole
 * non-redundant behaviour was a defect, so it is gone rather than kept.
 */

// cm:guard do NOT re-introduce `pipelineConfig.mergeStates` as a reader here. Migration 0195 deleted the key from every project and `pipelineConfigSchema` strips it from any save, so the resolver this replaced could only return this constant — at the cost of a `projects` SELECT inside every status transition's transaction (ISS-863).
import type { IssueStatus } from '../db/schema.js';
import { type MergeRecordExecutor, recordIssueMerge } from './merge-record.js';

/** The status an issue stands at while its release is waiting to be pressed. */
export const BASE_MERGE_STATE: IssueStatus = 'awaiting_release';

/**
 * Stamp `merged_at` when an issue transitions to `closed` and the column is
 * still NULL. `closed` is the ONLY terminal-done status (there is no
 * `cancelled`/`wontfix`), so a close — from any surface: UI, MCP, REST — means
 * "done" and must satisfy the L2 `blocks` gate for dependents.
 *
 * Rationale (getcontent 2026-07-13 incident): the ISS-639 gate fix stopped
 * treating `closed`+`merged_at IS NULL` blockers as satisfied under a stampable
 * base, which was correct for abandoned code but silently wedged every
 * hand-closed issue — the dependents' queued jobs just vanished from the picker
 * with no event. Requiring callers to disambiguate at close time (a
 * `resolution` param) would drift across surfaces, so the kernel infers instead:
 * close ⇒ done ⇒ stamp.
 *
 * ISS-1073 left this writer standing and made it say what it is. It stamps an
 * ASSERTION and cannot write a commit — the type refuses one — so a stamp with
 * no sha beside it now means exactly one thing: nobody observed a merge for this
 * issue. And the assertion is provisional: a merge Forge later observes replaces
 * it and takes the merge's own time (`merge-record.ts`).
 */
// cm:guard the surviving reason, stated rather than assumed, because ISS-1073's own rule is that a writer kept because removing it was expensive is the defect again. What keeps it is not cost: `merged_at` carries two truths at once — this landed, and this is settled enough to release dependents — and outcome 2 addresses only the first. A close is the second, an issue closed as not-work has to release its children, and separating the two needs a column of its own and a move of all nine readers of the gate. docs/proposals/merged-at-is-two-truths.md carries that residual.
// cm:flow release/close after:stamp — closing stamps merged_at when it is still null, which is why closing an issue that was never work unblocks its dependents as if it had shipped; unmark is the only reversal
export async function markMergedOnClose(
  executor: MergeRecordExecutor,
  args: { issueId: string; toStatus: IssueStatus },
): Promise<{ stamped: boolean }> {
  if (args.toStatus !== 'closed') return { stamped: false };
  const record = await recordIssueMerge(executor, {
    issueId: args.issueId,
    evidence: { kind: 'asserted', via: 'close' },
  });
  return { stamped: record.wrote };
}
