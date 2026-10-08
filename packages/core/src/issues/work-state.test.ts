import { describe, expect, it } from 'vitest';
import { issueStatuses } from '../db/schema.js';
import {
  emptyWorkStateCounts,
  foldWorkStates,
  OPEN_WORK_STATES,
  OPEN_WORK_STATUSES,
  openWorkCountsOf,
  openWorkTotal,
  QUESTION_LIFTED_STATUSES,
  STATUS_WORK_STATE,
  statusesInWorkState,
  WORK_STATES,
  workStateOf,
} from './work-state.js';

describe('the status map', () => {
  it('files every schema status in exactly one state', () => {
    expect(Object.keys(STATUS_WORK_STATE).sort()).toEqual([...issueStatuses].sort());
    const listed = WORK_STATES.flatMap((s) => statusesInWorkState(s));
    expect([...listed].sort()).toEqual([...issueStatuses].sort());
  });

  it('lifts exactly the statuses of the states an agent holds, as the rule says', () => {
    expect([...QUESTION_LIFTED_STATUSES].sort()).toEqual(
      [...statusesInWorkState('open'), ...statusesInWorkState('in_flight')].sort(),
    );
  });

  it('counts dropped, draft and closed in no open work state', () => {
    for (const s of ['dropped', 'draft', 'closed'] as const) {
      expect(OPEN_WORK_STATUSES).not.toContain(s);
    }
    expect(OPEN_WORK_STATUSES).toContain('awaiting_release');
  });
});

describe('workStateOf', () => {
  it('reads a status as its own state, and a question lifts only an issue an agent holds', () => {
    expect(workStateOf('in_progress')).toBe('in_flight');
    expect(workStateOf('in_progress', true)).toBe('blocked_on_person');
    expect(workStateOf('open', true)).toBe('blocked_on_person');
    expect(workStateOf('awaiting_release', true)).toBe('awaiting_release');
    expect(workStateOf('closed', true)).toBe('finished');
    expect(workStateOf('draft', true)).toBe('draft');
  });
});

describe('foldWorkStates', () => {
  it('sums rows into the six states, with a person owing an answer counted as blocked', () => {
    const counts = foldWorkStates([
      { status: 'open', owesAnswer: false, n: 56 },
      { status: 'open', owesAnswer: true, n: 2 },
      { status: 'in_progress', owesAnswer: false, n: 3 },
      { status: 'releasing', owesAnswer: false, n: 1 },
      { status: 'tested', owesAnswer: false, n: 1 },
      { status: 'needs_info', owesAnswer: true, n: 2 },
      { status: 'reopen', owesAnswer: false, n: 1 },
      { status: 'draft', owesAnswer: false, n: 24 },
      { status: 'dropped', owesAnswer: false, n: 53 },
      { status: 'closed', owesAnswer: false, n: 1253 },
    ]);
    expect(counts).toEqual({
      open: 56,
      in_flight: 4,
      awaiting_release: 1,
      blocked_on_person: 5,
      draft: 24,
      finished: 1306,
    });
  });

  it('adds up to the rows it was given, so nothing is counted twice or dropped', () => {
    const rows = issueStatuses.flatMap((status, i) => [
      { status, owesAnswer: false, n: i + 1 },
      { status, owesAnswer: true, n: 2 * (i + 1) },
    ]);
    const counts = foldWorkStates(rows);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(
      rows.reduce((a, r) => a + r.n, 0),
    );
  });

  it('refuses a status the schema does not hold by name, rather than counting it as nothing', () => {
    expect(() => foldWorkStates([{ status: 'parked', owesAnswer: false, n: 1 }])).toThrow(
      /`parked` is not one of the issue statuses/,
    );
  });

  it('is all zeros over no rows', () => {
    expect(foldWorkStates([])).toEqual(emptyWorkStateCounts());
  });
});

describe('open work', () => {
  it('sums the four open states and leaves drafts and finished work out', () => {
    const counts = {
      open: 5,
      in_flight: 7,
      awaiting_release: 1,
      blocked_on_person: 3,
      draft: 100,
      finished: 1000,
    };
    expect(openWorkTotal(counts)).toBe(16);
    expect(Object.keys(openWorkCountsOf(counts)).sort()).toEqual([...OPEN_WORK_STATES].sort());
  });
});
