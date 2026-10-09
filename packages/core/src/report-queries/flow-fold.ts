// The work-over-time folds the flow queries share, over `issues/flow-history.ts:readIssueFlow`: where
// an issue stood at a moment, which moves fall inside a window, and how long each status was held
// inside one. Pure, so a query only picks its window and lays the answer out as a frame.

import {
  ISSUE_RESOLVED_STATUSES,
  ISSUE_TERMINAL_STATUSES,
  NON_OPEN_STATUSES,
} from '@forge/contracts/issue-machine';
import type { FlowIssue, FlowMove, IssueFlow } from '../issues/index.js';

/** The move into each of these is what a flow report counts. */
export const FLOW_EVENTS = {
  /** Merged and proven against its criteria: the machine's `merged.and.proven` edge. */
  verified: 'awaiting_release',
  /** Released: the `release.recorded` edge. */
  closed: 'closed',
  /** Sent back after it was taken as done: a failed release, or a closed issue returned. */
  sentBack: 'reopen',
} as const;

export interface Window {
  from: Date;
  until: Date;
}

/** Each issue's moves, oldest first. */
export function movesByIssue(flow: IssueFlow): Map<string, FlowMove[]> {
  const out = new Map<string, FlowMove[]>();
  for (const m of flow.moves) {
    const list = out.get(m.issueId) ?? [];
    list.push(m);
    out.set(m.issueId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.at.getTime() - b.at.getTime());
  return out;
}

/**
 * Where an issue stood at `at`: null before it was filed; else the status its last move by then
 * entered, the status its first move left where none had happened yet, and its status now where it
 * never moved.
 */
export function statusAt(issue: FlowIssue, moves: readonly FlowMove[], at: Date): string | null {
  if (issue.createdAt.getTime() > at.getTime()) return null;
  let last: FlowMove | undefined;
  for (const m of moves) {
    if (m.at.getTime() > at.getTime()) break;
    last = m;
  }
  if (last) return last.to;
  return moves[0]?.from ?? issue.status;
}

const inside = (at: Date, w: Window) =>
  at.getTime() >= w.from.getTime() && at.getTime() < w.until.getTime();

/** The moves into `to` inside the window. */
export const movesInto = (flow: IssueFlow, to: string, w: Window): FlowMove[] =>
  flow.moves.filter((m) => m.to === to && inside(m.at, w));

/** The issues filed inside the window. */
export const filedIn = (flow: IssueFlow, w: Window): FlowIssue[] =>
  flow.issues.filter((i) => inside(i.createdAt, w));

/** A status that is still work to do: not resolved, not over, not a draft nobody admitted. */
export const isOpenStatus = (status: string): boolean =>
  !(NON_OPEN_STATUSES as readonly string[]).includes(status);

export const isResolvedStatus = (status: string): boolean =>
  (ISSUE_RESOLVED_STATUSES as readonly string[]).includes(status);

export const isDroppedStatus = (status: string): boolean => status === 'dropped';

/**
 * How long, in milliseconds, the project's issues held each status inside the window, summed over
 * issues. The statuses an issue is over at (closed, dropped) are left out: time there is not time
 * spent on the work.
 */
export function timeInStatus(flow: IssueFlow, w: Window): Map<string, number> {
  const out = new Map<string, number>();
  const byIssue = movesByIssue(flow);
  const add = (status: string, from: number, until: number) => {
    if ((ISSUE_TERMINAL_STATUSES as readonly string[]).includes(status)) return;
    const a = Math.max(from, w.from.getTime());
    const b = Math.min(until, w.until.getTime());
    if (b > a) out.set(status, (out.get(status) ?? 0) + (b - a));
  };
  for (const issue of flow.issues) {
    const moves = byIssue.get(issue.id) ?? [];
    let status = moves[0]?.from ?? issue.status;
    let since = issue.createdAt.getTime();
    for (const m of moves) {
      add(status, since, m.at.getTime());
      status = m.to;
      since = m.at.getTime();
    }
    add(status, since, w.until.getTime());
  }
  return out;
}

const DAY_MS = 86_400_000;

/** The window of `days` ending at `now`, and the one of the same length just before it. */
export function periodPair(days: number, now: Date): { current: Window; previous: Window } {
  const from = new Date(now.getTime() - days * DAY_MS);
  return {
    current: { from, until: now },
    previous: { from: new Date(from.getTime() - days * DAY_MS), until: from },
  };
}

/** An ISO calendar day, as a `date` cell holds one. */
export const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

/** Hours, to one decimal: how the reports state time spent, so a sentence can quote the cell. */
export const hoursOf = (ms: number): number => Math.round(ms / 360_000) / 10;
