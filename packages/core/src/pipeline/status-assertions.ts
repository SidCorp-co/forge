/**
 * What a status is allowed to claim, declared once so two readers cannot
 * disagree about it.
 *
 * A status asserts PLACEMENT — which gate the work sits at, whose move is
 * next — and nothing else. Every evidence question is answered by
 * {@link EVIDENCE_FIELDS}, raw columns a reader can look at.
 *
 * ISS-940 is why the split is named and typed rather than described: four
 * runs reached one real state and recorded four statuses, because `developed`
 * carried a placement promise from this repo's lifecycle guide and an
 * evidence promise from the driver plugin's contract, and direct-ship is
 * where the two come apart permanently. Drawn in
 * docs/flows/issue-status-placement.html.
 */

import { type IssueStatus, issueStatuses } from '../db/schema.js';

/** Which gate the work sits at. Says nothing about what exists. */
export type Gate =
  | 'intake'
  | 'queue'
  | 'plan'
  | 'build'
  | 'review'
  | 'qa'
  | 'release'
  | 'paused'
  | 'terminal';

/** Whose move it is for the issue to leave this gate. */
export type NextActor = 'agent' | 'human' | 'none';

// cm:guard two fields, both placement, and a third must not be added. A field naming a commit, a branch, a merge or a landing would put an evidence claim back inside a status, which is the ISS-940 defect: `developed` meant "at the review gate" to one reader and "on the default branch" to another, and both cited a document. Evidence lives in EVIDENCE_FIELDS below, on the row, where it can be looked at rather than inferred.
export interface StatusAssertion {
  gate: Gate;
  nextActor: NextActor;
}

// cm:guard exhaustive by construction — a status added to `db/schema.ts#issueStatuses` without an entry here fails `tsc`. That refusal is the whole point: the next rung someone adds cannot inherit `developed`'s ambiguity by saying nothing, because saying nothing does not compile.
// cm:edge lockstep -> packages/core/src/pipeline/autonomous-dispatch.ts — `nextActor: 'agent'` must hold for exactly the statuses `autonomousStepFor` returns a step at; a status that dispatches while claiming a human owes the next move sends a person to look at work an agent is already doing, and one that claims an agent while nothing dispatches is the wedge ISS-890 measured.
export const STATUS_ASSERTIONS: Record<IssueStatus, StatusAssertion> = {
  draft: { gate: 'intake', nextActor: 'human' },
  open: { gate: 'queue', nextActor: 'agent' },
  confirmed: { gate: 'plan', nextActor: 'human' },
  clarified: { gate: 'plan', nextActor: 'human' },
  approved: { gate: 'build', nextActor: 'human' },
  in_progress: { gate: 'build', nextActor: 'human' },
  developed: { gate: 'review', nextActor: 'human' },
  testing: { gate: 'qa', nextActor: 'human' },
  tested: { gate: 'release', nextActor: 'human' },
  awaiting_release: { gate: 'release', nextActor: 'human' },
  // cm:guard `nextActor: 'human'` and NOT 'agent', although a batch is running: the lockstep rule above binds 'agent' to the statuses `autonomousStepFor` dispatches at, and that is `open` alone. The release batch is not a claimable step, and claiming otherwise would send a master at a row `TERMINAL_FOR_DISPATCH` refuses.
  releasing: { gate: 'release', nextActor: 'human' },
  reopen: { gate: 'build', nextActor: 'human' },
  waiting: { gate: 'paused', nextActor: 'human' },
  on_hold: { gate: 'paused', nextActor: 'human' },
  needs_info: { gate: 'paused', nextActor: 'human' },
  closed: { gate: 'terminal', nextActor: 'none' },
  dropped: { gate: 'terminal', nextActor: 'none' },
};

/**
 * The columns that answer "did the work happen, and did it land". Named here
 * so the answer has one address; read them, do not infer them from a status.
 *
 * `merged_at` is caller-asserted rather than verified — any hop out of the
 * project's base merge state stamps it (`issues/merged-at.ts`) — so it is
 * evidence of a claim, which is exactly what an evidence field is.
 */
export const EVIDENCE_FIELDS = {
  landed: 'issues.merged_at',
  branch: 'issues.session_context.branch',
  commit: "issue_step_contexts kind='handoff' payload.commitSha",
} as const;

/**
 * True when nothing in Forge will move this issue on its own. `open` is the
 * single status a job is dispatched at, so every other live status is a person's
 * move — including the ones that read like work in flight.
 */
export function awaitsHuman(status: IssueStatus): boolean {
  return STATUS_ASSERTIONS[status].nextActor === 'human';
}

export function isTerminalPlacement(status: IssueStatus): boolean {
  return STATUS_ASSERTIONS[status].gate === 'terminal';
}

export const LIVE_STATUSES: readonly IssueStatus[] = issueStatuses.filter(
  (s) => !isTerminalPlacement(s),
);
