/**
 * ISS-1064 — `maxNotesKept`: the cleanup's count against the task's bound, under `repeated_call`.
 */

import { describe, expect, it } from 'vitest';
import { gradeTurn, type TurnFacts } from './grade.js';
import type { Check } from './task.js';

const facts = (notesKept: number | null): TurnFacts => ({
  delivered: 'Priya Raman; Wednesday.',
  attempts: [],
  seconds: 1,
  budgetSeconds: 60,
  values: {},
  lookups: {},
  preferenceRows: [],
  notesKept,
});
const check: Check = { kind: 'maxNotesKept', max: 2 };
const grade = (notesKept: number | null) =>
  gradeTurn({ message: 'm', checks: [check] }, facts(notesKept));

describe('maxNotesKept', () => {
  it('passes at or under the bound, fails over it naming both counts, fails an unknown count naming the refused listing', () => {
    expect(grade(0).evidence).toEqual([]);
    expect(grade(2).evidence).toEqual([]);
    expect(grade(3)).toMatchObject({
      pass: false,
      modes: ['repeated_call'],
      evidence: [{ mode: 'repeated_call', fact: 'kept 3 note(s), at most 2 allowed' }],
    });
    expect(grade(null).evidence).toEqual([
      { mode: 'repeated_call', fact: 'notes kept unknown: the memory listing was refused' },
    ]);
  });
});
