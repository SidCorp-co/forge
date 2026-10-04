import type { IssueStatus } from '../db/schema.js';

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
type NextActor = 'agent' | 'human' | 'none';

export interface StatusAssertion {
  gate: Gate;
  nextActor: NextActor;
}

const STATUS_ASSERTIONS: Record<IssueStatus, StatusAssertion> = {
  draft: { gate: 'intake', nextActor: 'human' },
  open: { gate: 'queue', nextActor: 'agent' },
  approved: { gate: 'build', nextActor: 'human' },
  in_progress: { gate: 'build', nextActor: 'human' },
  awaiting_release: { gate: 'release', nextActor: 'human' },
  reopen: { gate: 'build', nextActor: 'human' },
  on_hold: { gate: 'paused', nextActor: 'human' },
  needs_info: { gate: 'paused', nextActor: 'human' },
  closed: { gate: 'terminal', nextActor: 'none' },
  dropped: { gate: 'terminal', nextActor: 'none' },
};

export function isTerminalPlacement(status: IssueStatus): boolean {
  return STATUS_ASSERTIONS[status].gate === 'terminal';
}
