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

export interface StatusAssertion {
  gate: Gate;
  nextActor: NextActor;
}

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
  releasing: { gate: 'release', nextActor: 'human' },
  reopen: { gate: 'build', nextActor: 'human' },
  waiting: { gate: 'paused', nextActor: 'human' },
  on_hold: { gate: 'paused', nextActor: 'human' },
  needs_info: { gate: 'paused', nextActor: 'human' },
  closed: { gate: 'terminal', nextActor: 'none' },
  dropped: { gate: 'terminal', nextActor: 'none' },
};

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
