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

// cm:guard ADVISORY, NOT A GATE — and read by NOTHING outside this file today. `canTransitionFree` below is the only runtime check and it permits ANY non-draft from → ANY non-draft to, so reading a missing pair here as "illegal" has produced wrong conclusions and pointless multi-hop workarounds. The consumers this guard used to name are gone: the soft-skip resolver was deleted by ISS-897 and nothing imports `transitions`, `canTransition` or `getAllowedTransitions`. It is kept because step 5 of the removal order makes it the gate — which is the one change that turns every row here from advice into a refusal, so a row that is merely stale becomes a rule.
export const transitions: Record<IssueStatus, readonly IssueStatus[]> = {
  open: ['confirmed', 'in_progress', 'needs_info', 'on_hold', 'dropped'],
  // cm:guard `confirmed` is where A READER has said what the issue is and AN EXECUTOR owes the next move — that party boundary is the whole justification for the rung, and a row here with no confirmation record on it is the shape the 2026-09-10 retirement was aimed at. It came back because the wave model split those two parties; the driver's ladder (forge-plugin `flow/earned.mjs` ORDER) has always named it, so a kernel that called it retired was the half that was wrong.
  confirmed: ['approved', 'in_progress', 'needs_info', 'on_hold', 'dropped'],
  // cm:guard `approved` is where A DECISION, A PLAN AND CRITERIA exist and THE BUILD owes the next move. `in_progress` was its only exit while it was a retired drain route and stays its forward hop now, so no exit is lost. Neither this rung nor `confirmed` may join `AUTONOMOUS_DRIVER_STATUSES`: that list is subtracted to build `BACKLOG_ADMISSIBLE_STATUSES`, and every config naming a status that leaves it stops parsing WHOLE (ISS-976).
  approved: ['in_progress', 'needs_info', 'on_hold', 'dropped'],
  // cm:guard `closed` stays reachable from `in_progress` for a project with NO release gate — `resolveAgentCloseTarget` only rewrites an agent's close when `resolveReleaseGate` answers, so on a gateless project the agent closes from whatever rung it is standing on. Remove this and that close has nowhere legal to land.
  in_progress: ['developed', 'closed', 'needs_info', 'on_hold', 'dropped'],
  // cm:guard `developed` and `testing` are the review and QA rungs, and they are NOT in `AUTONOMOUS_DRIVER_STATUSES` on purpose: that list is subtracted to build `BACKLOG_ADMISSIBLE_STATUSES`, so adding them would take them OFF the backlog menu — and sidpeak declares both in `poolBacklog.statuses` precisely so a master can pick up work sitting there. Leaving them admissible is what makes a dead session at either rung recoverable by the next master rather than stranded.
  developed: ['testing', 'reopen', 'needs_info', 'on_hold', 'dropped'],
  testing: ['awaiting_release', 'closed', 'reopen', 'needs_info', 'on_hold', 'dropped'],
  awaiting_release: ['releasing', 'needs_info', 'on_hold', 'dropped'],
  // cm:guard the two OUTCOME exits are `finish`'s and `abort`'s alone; the parks are a person stopping to ask. Nothing else may leave, which is what stops an agent declaring its own release finished (issues/release-gate-hold.ts).
  releasing: ['closed', 'reopen', 'needs_info', 'on_hold'],
  closed: ['reopen'],
  // cm:guard `developed` is a legal reopen target because a failed check sends the work back to the rung that owes the proof, not to the start — the plugin's own `FALLS_TO` maps `wrong-test` there (forge-plugin `flow/route.mjs`). `isReopenEntry` counts these as real rejections and excludes only `in_progress → reopen`, the system's mechanical recovery.
  reopen: ['in_progress', 'developed', 'needs_info', 'on_hold', 'dropped'],

  // cm:guard a park must be able to put the issue back on the rung it LEFT, which is why these two rows list every live rung rather than one exit each. `awaiting_release` is the case that matters: an issue merged and waiting for production, parked and then answered, must not be forced through `open` — that dispatches a fresh agent onto shipped work (the ISS-940 shape) and loses its place at the gate. `pipeline/answer-resume.ts` does exactly that today, unconditionally, because nothing records the rung a park left; it is safe only while this map is advisory, and step 5 of the removal order cannot land before that is fixed.
  needs_info: [
    'open',
    'confirmed',
    'approved',
    'in_progress',
    'developed',
    'testing',
    'awaiting_release',
    'on_hold',
    'dropped',
  ],
  on_hold: [
    'open',
    'confirmed',
    'approved',
    'in_progress',
    'developed',
    'testing',
    'awaiting_release',
    'needs_info',
    'dropped',
  ],

  // cm:guard this row is the ADVISORY twin of `DRAFT_EXIT_TARGETS` and must list the same statuses — it is what the UI offers as next states, and offering three of the five legal exits is how a person concludes the other two are refused (ISS-940)
  draft: [...DRAFT_EXIT_TARGETS],
  // cm:guard terminal with NO exit, unlike `closed → reopen`: reopening a dropped issue would leave `merged_at` NULL on an issue that then ships, so re-filing is the correct move and this map must not offer a shortcut past it
  dropped: [],

  // cm:guard the three rows below are RETIRED statuses, kept only until their rows are drained, and their exits are deliberately DRAIN ROUTES onto live rungs rather than the old ladder hops — the whole point of listing them is to get an issue off them. Do not extend them, and do not add a hop BETWEEN two of them. `tested` is the one to watch: it holds the most rows, it is what forge-plugin writes today where this flow says `testing`, and sidpeak names it in `poolBacklog.statuses`, so dropping it from the enum has to move that config in the same change.
  // cm:guard `confirmed` and `approved` were retired here beside these three and are LIVE RUNGS again above, because the rule the retirement was judged against — a rung earns its place when a DIFFERENT party owes the next move — answers the other way under the wave model. Moving either back into this block is a change forge-plugin's ladder does not have, and this repo cannot edit that repo (ISS-976).
  clarified: ['in_progress', 'needs_info', 'on_hold', 'dropped'],
  waiting: ['open', 'in_progress', 'needs_info', 'on_hold', 'dropped'],
  tested: ['awaiting_release', 'closed', 'reopen', 'needs_info', 'on_hold', 'dropped'],
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
