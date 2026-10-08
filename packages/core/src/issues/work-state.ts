import type { IssueStatus } from '../db/schema.js';

/**
 * The state of work, core's copy of `@forge/contracts/work-state`, which core cannot import at
 * runtime; `db/status-sets-parity.test.ts` holds the two equal. Core is the only side that counts:
 * every figure of work is a `foldWorkStates` over `(status, owesAnswer, n)` rows.
 */

export const WORK_STATES = [
  'open',
  'in_flight',
  'awaiting_release',
  'blocked_on_person',
  'draft',
  'finished',
] as const;

export type WorkState = (typeof WORK_STATES)[number];

export const OPEN_WORK_STATES = [
  'open',
  'in_flight',
  'awaiting_release',
  'blocked_on_person',
] as const satisfies readonly WorkState[];

export type OpenWorkState = (typeof OPEN_WORK_STATES)[number];

export const STATUS_WORK_STATE: Readonly<Record<IssueStatus, WorkState>> = {
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
export function workStateOf(status: IssueStatus, owesAnswer = false): WorkState {
  const state = STATUS_WORK_STATE[status];
  return owesAnswer && (state === 'open' || state === 'in_flight') ? 'blocked_on_person' : state;
}

export function statusesInWorkState(state: WorkState): IssueStatus[] {
  return (Object.keys(STATUS_WORK_STATE) as IssueStatus[]).filter(
    (s) => STATUS_WORK_STATE[s] === state,
  );
}

/** The statuses a question moves to another state, derived from the rule above and never listed again. */
export const QUESTION_LIFTED_STATUSES: readonly IssueStatus[] = (
  Object.keys(STATUS_WORK_STATE) as IssueStatus[]
).filter((s) => workStateOf(s, true) !== workStateOf(s, false));

/** The statuses of open work, for a query that has no use for the question. */
export const OPEN_WORK_STATUSES: readonly IssueStatus[] = OPEN_WORK_STATES.flatMap((s) =>
  statusesInWorkState(s),
);

export type WorkStateCounts = Record<WorkState, number>;

export const emptyWorkStateCounts = (): WorkStateCounts => ({
  open: 0,
  in_flight: 0,
  awaiting_release: 0,
  blocked_on_person: 0,
  draft: 0,
  finished: 0,
});

export interface WorkStateRow {
  status: string;
  owesAnswer: boolean;
  n: number;
}

/** A status the schema does not hold is refused by name, never counted as nothing. */
function stateOfRow(row: WorkStateRow): WorkState {
  if (!(row.status in STATUS_WORK_STATE)) {
    throw new Error(
      `work state: the status \`${row.status}\` is not one of the issue statuses (${Object.keys(STATUS_WORK_STATE).join(', ')}), so no state can count it`,
    );
  }
  return workStateOf(row.status as IssueStatus, row.owesAnswer);
}

export function foldWorkStates(rows: readonly WorkStateRow[]): WorkStateCounts {
  const counts = emptyWorkStateCounts();
  for (const row of rows) counts[stateOfRow(row)] += row.n;
  return counts;
}

export type OpenWorkCounts = Record<OpenWorkState, number>;

export function openWorkCountsOf(counts: WorkStateCounts): OpenWorkCounts {
  return {
    open: counts.open,
    in_flight: counts.in_flight,
    awaiting_release: counts.awaiting_release,
    blocked_on_person: counts.blocked_on_person,
  };
}

/** Open work: the four open states summed from a count per state. */
export function openWorkTotal(counts: Readonly<Partial<Record<WorkState, number>>>): number {
  return OPEN_WORK_STATES.reduce((n, s) => n + (counts[s] ?? 0), 0);
}
