import { type IssueStatus, issueStatuses } from '../db/schema.js';

export type { IssueStatus };
export { issueStatuses };

export const DRAFT_EXIT_TARGETS: readonly IssueStatus[] = [
  'open',
  'closed',
  'dropped',
  'developed',
  'in_progress',
];

export const transitions: Record<IssueStatus, readonly IssueStatus[]> = {
  open: ['confirmed', 'in_progress', 'needs_info', 'on_hold', 'dropped'],
  confirmed: ['approved', 'in_progress', 'needs_info', 'on_hold', 'dropped'],
  approved: ['in_progress', 'needs_info', 'on_hold', 'dropped'],
  in_progress: ['developed', 'closed', 'needs_info', 'on_hold', 'dropped'],
  developed: ['testing', 'reopen', 'needs_info', 'on_hold', 'dropped'],
  testing: ['awaiting_release', 'closed', 'reopen', 'needs_info', 'on_hold', 'dropped'],
  awaiting_release: ['releasing', 'needs_info', 'on_hold', 'dropped'],
  releasing: ['closed', 'reopen', 'needs_info', 'on_hold'],
  closed: ['reopen'],
  reopen: ['in_progress', 'developed', 'needs_info', 'on_hold', 'dropped'],

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

  draft: [...DRAFT_EXIT_TARGETS],
  dropped: [],

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

export function isReopenEntry(from: IssueStatus, to: IssueStatus): boolean {
  return to === 'reopen' && from !== 'reopen' && from !== 'in_progress';
}

/**
 * The soft-skip resolver was deleted here by ISS-897, and re-adding one is re-adding the staged
 * lane. `STAGE_FORWARD`, `SKIPPABLE_STAGES`, `MAX_SKIP_CHAIN`, `resolveSkipTarget` and
 * `validateStatesConfig` walked a nine-rung ladder past stages an operator had disabled; there are
 * four statuses now, only `open` dispatches, and disabling it is the human gate rather than a dead
 * end to route around.
 *
 * This file is the ONE place those five names may appear, which is not a convention but a thing
 * `pipeline/soft-skip-stays-deleted.test.ts` scans the whole source tree to assert. Deleting this
 * block does not tidy a comment away, it makes that test red.
 */

export type StagesConfig = Partial<
  Record<
    IssueStatus,
    {
      enabled?: boolean;
      deviceIds?: string[];
      [extra: string]: unknown;
    }
  >
>;
