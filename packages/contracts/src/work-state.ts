import type { AutonomousLabel } from './issue-vocabulary.js';
import type { REGISTRY_ISSUE_STATUSES } from './pipeline-registry.js';

type KernelIssueStatus = (typeof REGISTRY_ISSUE_STATUSES)[number];

/** The state of work: the one answer every screen that counts or groups issues reads. The first four are open work. */
export const WORK_STATES = [
  'open',
  'in_flight',
  'awaiting_release',
  'blocked_on_person',
  'draft',
  'finished',
] as const;

export type WorkState = (typeof WORK_STATES)[number];

/** The words of the states. This is the only file that declares them. */
export const WORK_STATE_LABELS: Record<WorkState, string> = {
  open: 'Open, not picked up',
  in_flight: 'In flight',
  awaiting_release: 'Awaiting release',
  blocked_on_person: 'Blocked on a person',
  draft: 'Draft',
  finished: 'Finished',
};

/** The states whose issues are open work: not started excluded, and over excluded. */
export const OPEN_WORK_STATES = [
  'open',
  'in_flight',
  'awaiting_release',
  'blocked_on_person',
] as const satisfies readonly WorkState[];

export type OpenWorkState = (typeof OPEN_WORK_STATES)[number];

/** What the figure that sums the open states is called, and what it counts. */
export const OPEN_WORK_LABEL = 'Open work';
export const OPEN_WORK_DEFINITION = OPEN_WORK_STATES.map((s) => WORK_STATE_LABELS[s]).join(' · ');

/** Which state each kernel status is in. `Record` over the registry, so a status without a state fails the type check. */
export const STATUS_WORK_STATE: Record<KernelIssueStatus, WorkState> = {
  draft: 'draft',
  open: 'open',
  confirmed: 'in_flight',
  clarified: 'in_flight',
  approved: 'in_flight',
  in_progress: 'in_flight',
  developed: 'in_flight',
  testing: 'in_flight',
  releasing: 'in_flight',
  tested: 'awaiting_release',
  awaiting_release: 'awaiting_release',
  waiting: 'blocked_on_person',
  needs_info: 'blocked_on_person',
  on_hold: 'blocked_on_person',
  reopen: 'blocked_on_person',
  closed: 'finished',
  dropped: 'finished',
};

/** An issue an agent holds that a person owes an answer is blocked on them; a question moves no other status. */
export function workStateOf(status: KernelIssueStatus, owesAnswer = false): WorkState {
  const state = STATUS_WORK_STATE[status];
  return owesAnswer && (state === 'open' || state === 'in_flight') ? 'blocked_on_person' : state;
}

/** The statuses an issue can be at and read this state, whether or not a question is on it. */
export function statusesInWorkState(state: WorkState): KernelIssueStatus[] {
  return (Object.keys(STATUS_WORK_STATE) as KernelIssueStatus[]).filter(
    (s) => STATUS_WORK_STATE[s] === state,
  );
}

export function isWorkState(value: unknown): value is WorkState {
  return typeof value === 'string' && (WORK_STATES as readonly string[]).includes(value);
}

/** The state each lane label sits in, so a board column never straddles two states. */
export const LABEL_WORK_STATE: Record<AutonomousLabel, WorkState> = {
  draft: 'draft',
  open: 'open',
  running: 'in_flight',
  unheld: 'in_flight',
  needs_human: 'blocked_on_person',
  paused: 'blocked_on_person',
  reopened: 'blocked_on_person',
  awaiting_release: 'awaiting_release',
  done: 'finished',
  dropped: 'finished',
};

/** Open work: the four open states summed from a count per state. */
export function openWorkTotal(counts: Readonly<Partial<Record<WorkState, number>>>): number {
  return OPEN_WORK_STATES.reduce((n, s) => n + (counts[s] ?? 0), 0);
}

/**
 * The key a count of work is missing, or null where every one of `states` is a number. A response
 * from a core that predates the work states reads as a missing key by name, so a screen refuses it
 * rather than drawing zeros for work that is there.
 */
export function missingWorkStateKey(
  counts: unknown,
  states: readonly WorkState[] = WORK_STATES,
): WorkState | null {
  if (counts === null || typeof counts !== 'object') return states[0] ?? null;
  const record = counts as Record<string, unknown>;
  return states.find((s) => typeof record[s] !== 'number') ?? null;
}
