/**
 * ISS-1065 — `onlyFrom`: a reply naming a registry status outside the filled list fails, naming the
 * state and the list; prose and arrows pass; `in_progress` is one token and `progress` none.
 */

import { describe, expect, it } from 'vitest';
import { gradeTurn, type TurnFacts } from './grade.js';
import type { Check } from './task.js';

const facts = (delivered: string | null): TurnFacts => ({
  delivered,
  attempts: [],
  seconds: 1,
  budgetSeconds: 60,
  values: { stateList: 'open, in_progress, awaiting_release' },
  lookups: {},
  preferenceRows: [],
});
const grade = (check: Check, delivered: string | null) =>
  gradeTurn({ message: 'm', checks: [check] }, facts(delivered)).evidence;

describe('onlyFrom', () => {
  it('onlyFrom fails a reply naming a registry state outside the list, and reads in_progress as one token (ISS-1065)', () => {
    const check: Check = { kind: 'onlyFrom', list: '{stateList}' };
    expect(grade(check, 'open → in_progress → awaiting_release')).toEqual([]);
    expect(grade(check, 'First open, then in_progress, and finally awaiting_release.')).toEqual([]);
    expect(grade(check, 'The progress is tracked; nothing is in review.')).toEqual([]);
    expect(
      grade(check, 'open → confirmed → in_progress → testing → awaiting_release → closed').map(
        (e) => e.fact,
      ),
    ).toEqual([
      'reply names state confirmed outside open, in_progress, awaiting_release',
      'reply names state testing outside open, in_progress, awaiting_release',
      'reply names state closed outside open, in_progress, awaiting_release',
    ]);
    expect(grade(check, 'closed, closed, open').map((e) => e.mode)).toEqual(['unanswered']);
    expect(grade(check, null)).toEqual([
      { mode: 'unanswered', fact: 'no assistant message delivered' },
    ]);
  });
});
