/**
 * ISS-232 — git-aware Layer-2 dependency gate.
 *
 * The picker's L2 gate asks "is the parent's `merged_at` NULL?" rather than
 * "is the parent's status in (released, closed)?" — status doesn't carry merge
 * state for trunk-based repos. The state-machine is the SSOT writer: whenever
 * an issue transitions OUT of {@link BASE_MERGE_STATE},
 * {@link markMergedIfLeavingBase} stamps `merged_at = now()`. Idempotent via
 * `WHERE merged_at IS NULL` so a crash + retry can't double-write.
 *
 * The writer lives here (not inside skill code) so a crash between
 * "skill pushed the merge" and "status transition committed" leaves
 * merged_at NULL — children stay blocked, which is correct (the merge may
 * not have made it to origin). Skill operators are responsible for
 * verifying the push BEFORE issuing the transition.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';

/** Drizzle transaction handle — same shape `withActorContext` accepts.
 *  `Parameters<…>` chains expand to the inner-callback argument type. */
type DrizzleTx = Parameters<Parameters<Db['transaction']>[0]>[0];

// cm:guard do NOT re-introduce `pipelineConfig.mergeStates` as a reader here. Migration 0195 deleted the key from every project and `pipelineConfigSchema` strips it from any save, so the resolver this replaced could only return this constant — at the cost of a `projects` SELECT inside every status transition's transaction (ISS-863).
/** The status an issue leaves to have its merge stamped. */
export const BASE_MERGE_STATE: IssueStatus = 'released';

/**
 * Stamp `merged_at = now()` when an issue transitions OUT of
 * {@link BASE_MERGE_STATE}. No-op for every other transition. Idempotent via
 * `WHERE merged_at IS NULL` so the helper is safe to call on every
 * transition site (REST `/transition`, batch `/issues`, MCP-driven
 * `applyStatusTransition`, orchestrator soft-skip) without coordinating.
 *
 * Caller must invoke this inside the same transaction as the
 * `UPDATE issues.status` so a rollback drops both writes together.
 */
// cm:flow release/stamp — the hop OUT of the base branch stamps merged_at, and that stamp is what unblocks every kind='blocks' dependent; nothing here verifies a merge actually happened
export async function markMergedIfLeavingBase(
  tx: DrizzleTx,
  args: {
    issueId: string;
    fromStatus: IssueStatus;
    toStatus: IssueStatus;
  },
): Promise<{ stamped: boolean }> {
  if (args.fromStatus !== BASE_MERGE_STATE || args.toStatus === BASE_MERGE_STATE) {
    return { stamped: false };
  }
  const updated =
    (await tx
      .update(issues)
      .set({ mergedAt: sql`now()` })
      .where(and(eq(issues.id, args.issueId), isNull(issues.mergedAt)))
      .returning({ id: issues.id })) ?? [];
  return { stamped: updated.length > 0 };
}

/**
 * Stamp `merged_at = now()` when an issue transitions to `closed` and the
 * column is still NULL. `closed` is the ONLY terminal-done status (there is
 * no `cancelled`/`wontfix`), so a close — from any surface: UI, MCP, REST —
 * means "done" and must satisfy the L2 `blocks` gate for dependents.
 *
 * Rationale (getcontent 2026-07-13 incident): the ISS-639 gate fix stopped
 * treating `closed`+`merged_at IS NULL` blockers as satisfied under a
 * stampable base, which was correct for abandoned code but silently wedged
 * every hand-closed issue — the dependents' queued jobs just vanished from
 * the picker with no event. Requiring callers to disambiguate at close time
 * (a `resolution` param) would drift across surfaces, so the kernel infers
 * instead: close ⇒ done ⇒ stamp. The trade-off is deliberate:
 *   - pipeline closes already stamped on leaving the base merge state, so
 *     this is a no-op there (`WHERE merged_at IS NULL`);
 *   - ONE system path auto-closes, and it is gated on a release note existing
 *     (`release-record-required.ts`): the orchestrator's auto-skip
 *     chain, which anchors on `closed` when the `released` stage has no
 *     registered skill and is NOT exempt — it catches the refusal and stops.
 *     Everything else routes elsewhere (cancel → on_hold, failures →
 *     waiting/reopen);
 *   - a close-as-abandon wrongly unblocks dependents, but visibly (audit
 *     comment in `apply-transition.ts`) and reversibly (`unmark`) — better
 *     than the old failure mode of an invisible, indefinite wedge.
 *
 * Idempotent via `WHERE merged_at IS NULL`; call inside the same tx as the
 * status UPDATE so a rollback drops both writes together.
 */
// cm:flow release/close after:stamp — closing stamps merged_at when it is still null, which is why closing an issue that was never work unblocks its dependents as if it had shipped; unmark is the only reversal
export async function markMergedOnClose(
  tx: DrizzleTx,
  args: { issueId: string; toStatus: IssueStatus },
): Promise<{ stamped: boolean }> {
  if (args.toStatus !== 'closed') return { stamped: false };
  const updated =
    (await tx
      .update(issues)
      .set({ mergedAt: sql`now()` })
      .where(and(eq(issues.id, args.issueId), isNull(issues.mergedAt)))
      .returning({ id: issues.id })) ?? [];
  return { stamped: updated.length > 0 };
}
