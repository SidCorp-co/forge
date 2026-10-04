// Workflow `issue-lifecycle` rev 3's moves (ISS-54): a status says who it waits on, the run's step
// lives in `issue_work_state`. Enforced by `issues/apply-transition.ts` and `transition-guards.ts`.

import { type IssueStatus, issueStatuses } from '../db/schema.js';

export type { IssueStatus };
export { issueStatuses };

export const DRAFT_EXIT_TARGETS: readonly IssueStatus[] = ['open', 'dropped'];

/** The two parks: they store the status they left (`issue_work_state.left_status`) and return to it. */
export const PARK_STATUSES: readonly IssueStatus[] = ['needs_info', 'on_hold'];

export const PARKABLE_STATUSES: readonly IssueStatus[] = [
  'open',
  'reopen',
  'in_progress',
  'approved',
  'awaiting_release',
];

const SIDE_EXITS: readonly IssueStatus[] = ['needs_info', 'on_hold', 'dropped'];

/** Forward edges; a park's return is decided by its stored left status (`parkExitTargets`). */
export const transitions: Record<IssueStatus, readonly IssueStatus[]> = {
  draft: DRAFT_EXIT_TARGETS,
  open: ['in_progress', ...SIDE_EXITS],
  reopen: ['in_progress', ...SIDE_EXITS],
  in_progress: ['approved', 'awaiting_release', 'closed', ...SIDE_EXITS],
  approved: ['in_progress', ...SIDE_EXITS],
  awaiting_release: ['closed', 'reopen', ...SIDE_EXITS],
  needs_info: ['on_hold', 'dropped'],
  on_hold: ['needs_info', 'dropped'],
  closed: ['reopen'],
  dropped: [],
};

export function getAllowedTransitions(from: IssueStatus): readonly IssueStatus[] {
  return transitions[from];
}

/** A park's exits; `leftStatus` null (a park 0346 could not read) lets a person name any parkable status. */
export function parkExitTargets(
  from: IssueStatus,
  leftStatus: IssueStatus | null,
): readonly IssueStatus[] {
  const back = leftStatus === null ? PARKABLE_STATUSES : [leftStatus];
  return [...back, ...transitions[from]];
}

export function canTransition(
  from: IssueStatus,
  to: IssueStatus,
  leftStatus: IssueStatus | null = null,
): boolean {
  if (PARK_STATUSES.includes(from)) return parkExitTargets(from, leftStatus).includes(to);
  return transitions[from].includes(to);
}

// cm:why an `in_progress` issue nothing holds goes back where a master takes it, or it rests ownerless
// (ISS-54); only `recovery: true` reaches it: a kernel sweep, or a judge that failed and let go (BC-10).
export const RECOVERY_EDGES: Readonly<Partial<Record<IssueStatus, readonly IssueStatus[]>>> = {
  in_progress: ['open', 'approved', 'reopen'],
};

export function isRecoveryEdge(from: IssueStatus, to: IssueStatus): boolean {
  return RECOVERY_EDGES[from]?.includes(to) ?? false;
}
