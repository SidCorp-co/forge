import { beforeEach, describe, expect, it } from 'vitest';
import {
  advanceSweep,
  maxTraversalPages,
  resetSweepCursorsForTest,
  type SweepPosition,
  sweepPosition,
} from './sweep-cursor.js';

/**
 * ISS-1021 — the second wrap condition, which is the only one a GROWING candidate set can reach.
 *
 * Wrapping on a short page is enough while the set is finite and still. It is not enough when new
 * candidates keep arriving ahead of the cursor: every page is then full, the traversal never
 * reaches an end, and a row behind the cursor is never surfaced again — the same permanent blind
 * spot the cursor exists to remove, one level up. Raised by the implementation consult as F1 and
 * answered with a page ceiling.
 */
describe('a sweep traversal wraps even when its candidate set is growing (ISS-1021)', () => {
  const KEY = 'stranded:all';
  const at = (n: number): SweepPosition => ({ ts: `2026-09-17 00:00:0${n}+00`, id: `row-${n}` });

  beforeEach(() => {
    resetSweepCursorsForTest();
  });

  it('parks on a full page and clears on a short one', () => {
    advanceSweep(KEY, at(1), true);
    expect(sweepPosition(KEY)).toEqual(at(1));

    advanceSweep(KEY, at(2), false);
    expect(sweepPosition(KEY)).toBeNull();
  });

  it('wraps to the oldest candidate after a bounded run of full pages', () => {
    const ceiling = maxTraversalPages();

    // Every page is full, which is what a set gaining a page between passes looks like. Without
    // the ceiling this loop parks the cursor further forward forever and never returns null.
    let wrappedAfter: number | null = null;
    for (let pass = 1; pass <= ceiling * 3; pass++) {
      advanceSweep(KEY, at(pass), true);
      if (sweepPosition(KEY) === null) {
        wrappedAfter = pass;
        break;
      }
    }

    expect(wrappedAfter).toBe(ceiling);
  });

  it('starts the next traversal from the oldest row rather than from where the last one stopped', () => {
    for (let pass = 1; pass <= maxTraversalPages(); pass++) advanceSweep(KEY, at(pass), true);
    expect(sweepPosition(KEY)).toBeNull();

    // A fresh traversal, counted from zero: the ceiling is per-traversal, not a lifetime budget.
    advanceSweep(KEY, at(99), true);
    expect(sweepPosition(KEY)).toEqual(at(99));
  });

  it('counts every pass ceiling separately, so one sweep cannot wrap another', () => {
    const other = 'aged-holds';
    for (let pass = 1; pass <= maxTraversalPages() - 1; pass++) advanceSweep(KEY, at(pass), true);

    advanceSweep(other, at(1), true);

    expect(sweepPosition(other)).toEqual(at(1));
    expect(sweepPosition(KEY)).not.toBeNull();
  });
});
