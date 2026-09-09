import { type IssueStatus, issueStatuses } from '../db/schema.js';

export type { IssueStatus };
export { issueStatuses };

// cm:guard `dropped` is the RIGHT discard for a draft and `closed` is the wrong one: closing stamps merged_at, so discarding a draft today unblocks every dependent of an issue whose work never existed. Keep `closed` only because callers predate the status.
// cm:guard exported so the refusal in apply-transition.ts can NAME these instead of restating them — the message has to list the legal exits, and a second copy of the list is a message that goes stale without a single test going red
// cm:guard `in_progress` is a PLACEMENT exit and must not acquire an evidence meaning (packages/core/src/pipeline/status-assertions.ts): it says a session holds this draft, not that anything was built. It is safe from `resetAutonomousWedgesOnce` only because that pass requires a prior `drive` job row and a running issue run, and a draft worked by hand has neither — a wedge pass that stopped requiring a job would roll a live hand session's issue back to `open` and dispatch an agent into its worktree (ISS-940).
export const DRAFT_EXIT_TARGETS: readonly IssueStatus[] = [
  'open',
  'closed',
  'dropped',
  'developed',
  'in_progress',
];

// cm:guard ADVISORY, NOT A GATE. Nothing enforces this map. `canTransitionFree` below is the only runtime check and it permits ANY non-draft from → ANY non-draft to; reading a missing pair here as "illegal" has produced wrong conclusions and pointless multi-hop workarounds. Consumers are system-prompt generation, UI next-state suggestions and the soft-skip resolver.
export const transitions: Record<IssueStatus, readonly IssueStatus[]> = {
  open: ['confirmed', 'needs_info', 'on_hold'],
  confirmed: ['clarified', 'needs_info', 'on_hold'],
  clarified: ['waiting', 'approved', 'needs_info', 'on_hold'],
  waiting: ['approved', 'clarified', 'on_hold'],
  approved: ['in_progress', 'on_hold'],
  in_progress: ['developed', 'testing', 'reopen', 'on_hold'],
  developed: ['testing', 'reopen', 'on_hold'],
  testing: ['tested', 'reopen', 'on_hold'],
  // cm:guard the rows for `confirmed`, `clarified`, `waiting`, `approved`, `developed`, `testing`, `tested` and `released` describe a pipeline that no longer runs and are kept only until their rows are drained — docs/flows/issue-status-lifecycle.html is the flow, this map is not. Do not extend them.
  // cm:guard do not repoint STAGE_FORWARD's tested entry to 'closed' — projects with tested disabled would skip released entirely; the batch-release tested->closed exit stays advisory-only here
  tested: ['awaiting_release', 'closed', 'reopen', 'on_hold'],
  awaiting_release: ['closed', 'releasing', 'on_hold'],
  // cm:guard the two OUTCOME exits are `finish`'s and `abort`'s alone; the parks are a person stopping to ask. Nothing else may leave, which is what stops an agent declaring its own release finished (issues/release-gate-hold.ts).
  releasing: ['closed', 'reopen', 'needs_info', 'on_hold'],
  closed: ['reopen'],
  reopen: ['developed', 'testing', 'in_progress', 'on_hold'],
  on_hold: issueStatuses.filter((s) => s !== 'on_hold' && s !== 'draft'),
  needs_info: ['open', 'confirmed', 'on_hold'],
  // cm:guard this row is the ADVISORY twin of `DRAFT_EXIT_TARGETS` and must list the same statuses — it is what the UI offers as next states, and offering three of the five legal exits is how a person concludes the other two are refused (ISS-940)
  draft: [...DRAFT_EXIT_TARGETS],
  // cm:guard terminal with NO exit, unlike `closed → reopen`: reopening a dropped issue would leave `merged_at` NULL on an issue that then ships, so re-filing is the correct move and this map must not offer a shortcut past it
  dropped: [],
};

export function getAllowedTransitions(from: IssueStatus): readonly IssueStatus[] {
  return transitions[from];
}

export function canTransition(from: IssueStatus, to: IssueStatus): boolean {
  return transitions[from].includes(to);
}

/**
 * Statuses that may never be a transition TARGET at runtime. `draft` is an
 * AI-proposal ingress state (issues are created as draft, then promoted to
 * open/closed) — nothing in the live lifecycle transitions INTO draft.
 */
export const NON_TARGETABLE_STATUSES: ReadonlySet<IssueStatus> = new Set(['draft']);

/**
 * Permissive runtime transition guard. The strict `transitions` matrix above
 * is retained as the recommended happy-path — it drives system-prompt
 * generation, UI next-state suggestions, and the soft-skip resolver — but
 * agent- and operator-initiated status updates are deliberately NOT gated by
 * it. The pipeline is guided by the system prompt, not locked by a rigid
 * matrix, so an agent may branch to `needs_info` / `on_hold` / `reopen` from
 * any state, take a shortcut, or recover an edge case. The only hard rules:
 * no no-op (enforced by callers) and `draft` is never a runtime target.
 *
 * `merged_at` stays a side-effect of leaving the merge state (see
 * `markMergedIfLeavingBase`), so no caller writes it directly — but it is
 * caller-asserted, not verified: ANY hop out of `mergeStates.baseBranch`
 * stamps it, merge or not, and the stamp releases every `blocks` dependent.
 * Verify before relying on one, and clear a wrong stamp with `forge_issues`
 * `unmark`.
 *
 * Two guardrails survive (the "moderate" in moderately-strict):
 *   1. `draft` is never a target (issues only enter draft at creation).
 *   2. A `draft` may only move to the five `DRAFT_EXIT_TARGETS` — promoted to
 *      `open`, discarded to `dropped` (or `closed`), taken up in place at
 *      `in_progress`, or handed off DIRECT-SHIP to `developed` (ISS-431). An
 *      unaccepted AI proposal cannot teleport into early/mid pipeline stages.
 *
 * Direct-ship (`draft → developed`): work implemented OUTSIDE the pipeline
 * (an operator/assistant session pushing its own ISS-* branch) enters at the
 * review gate instead of bypassing it. Nothing dispatches there — `open` is
 * the only status a job is enqueued at — so the rung says where the work
 * sits and whose move is next, and says nothing about a merge. Walking
 * draft→open instead would auto-dispatch a drive job onto already-finished
 * work. Callers should set `sessionContext.branch` so a reviewer knows what
 * to diff.
 *
 * Taking it up in place (`draft → in_progress`): a session already building
 * the branch says so without promoting. ISS-940 measured the alternative —
 * ISS-933 sat at `draft` with a green-gated PR because `in_progress` was the
 * one rung refused here and `open` would have raced a runner-dispatched agent
 * against the session already in the worktree.
 */

export function canTransitionFree(from: IssueStatus, to: IssueStatus): boolean {
  if (NON_TARGETABLE_STATUSES.has(to)) return false;
  if (from === 'draft') return DRAFT_EXIT_TARGETS.includes(to);
  return true;
}

// cm:why ISS-781 — ANY entry into `reopen` is a reopen, not just `closed → reopen`. The pipeline's own rejection paths (developed → reopen on a review REQUEST CHANGES, testing → reopen on a failed live E2E) are precisely the churn this counter exists to measure, and gating on `closed` left reopenCount at 0 for all of them — which silently disabled the reopen cap (deleted 2026-08-25 — RFC 0002 INV-8 replaced it with the advisory `noProgressRounds`, see pipeline/reopen-policy.ts) and ISS-535 model escalation (escalateModel returns early at reopenCount <= 0).
// cm:why ISS-766 — excludes `in_progress → reopen`: that hop is the SYSTEM's own mechanical recovery, not an agent-requested rejection — finalize-failure's retry revert (jobs/finalize-failure.ts) and the reconciler's in-flight wedge reset (pipeline/reconciler.ts) both land here for infra flakes/usage-limit cuts, and counting them burned reopen-cap budget and bumped fix sonnet→opus (escalateModel) for churn that was never a real review/test rejection.
export function isReopenEntry(from: IssueStatus, to: IssueStatus): boolean {
  return to === 'reopen' && from !== 'reopen' && from !== 'in_progress';
}

// cm:guard the soft-skip resolver was deleted here by ISS-897, and re-adding one is re-adding the staged lane. `STAGE_FORWARD`, `SKIPPABLE_STAGES`, `MAX_SKIP_CHAIN`, `resolveSkipTarget` and `validateStatesConfig` walked a nine-rung ladder past stages an operator had disabled; there are four statuses now, only `open` dispatches, and disabling it is the human gate rather than a dead end to route around.

export type StagesConfig = Partial<
  Record<
    IssueStatus,
    {
      enabled?: boolean;
      mode?: 'auto' | 'manual';
      [extra: string]: unknown;
    }
  >
>;
