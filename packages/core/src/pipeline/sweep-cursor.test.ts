import { beforeEach, describe, expect, it } from 'vitest';
import {
  advanceSweep,
  resetSweepCursorsForTest,
  type SweepPosition,
  sweepWindow,
} from './sweep-cursor.js';

/**
 * ISS-1021 — the far edge, which is what makes a traversal finite.
 *
 * Wrapping on a short page is enough while the candidate set is still. It is not enough when new
 * rows keep arriving ahead of the cursor: every page is then full, the traversal never reaches an
 * end, and a row behind the cursor is never surfaced again. Raised by the implementation consult
 * as F1. A fixed ceiling on pages was the first answer and was WRONG — the recheck's F2 showed it
 * wraps a stable 2,001-row set at row 2,000 and never surfaces row 2,001, which is the original
 * defect at a different boundary. Freezing the pass's own upper cutoff for the traversal's length
 * is the answer that holds both cases, and these are the assertions that tell them apart.
 */
describe('a sweep traversal reads inside a frozen far edge (ISS-1021)', () => {
  const KEY = 'stranded:*';
  const at = (n: number): SweepPosition => ({ ts: `2026-09-17 00:00:0${n}+00`, id: `row-${n}` });
  const EDGE = '2026-09-17T09:00:00.000Z';
  const LATER = '2026-09-17T09:01:00.000Z';

  beforeEach(() => {
    resetSweepCursorsForTest();
  });

  it('takes the cutoff it is handed when no traversal is open', () => {
    expect(sweepWindow(KEY, EDGE)).toEqual({ after: null, until: EDGE });
  });

  it('keeps the edge it started with while the traversal is open, however the clock moves', () => {
    const first = sweepWindow(KEY, EDGE);
    advanceSweep(KEY, first, at(1), true);

    // The caller hands in the LIVE cutoff every tick — that is what would let a growing set
    // extend this traversal forever, and the window is what refuses it.
    const second = sweepWindow(KEY, LATER);

    expect(second.until).toBe(EDGE);
    expect(second.after).toEqual(at(1));
  });

  it('takes a fresh edge once a short page ends the traversal', () => {
    const first = sweepWindow(KEY, EDGE);
    advanceSweep(KEY, first, at(1), true);
    const second = sweepWindow(KEY, LATER);
    advanceSweep(KEY, second, at(2), false);

    const third = sweepWindow(KEY, LATER);

    // Wrapped: back to the oldest candidate, and everything that became eligible in the meantime
    // is inside this new traversal rather than shut out of it.
    expect(third).toEqual({ after: null, until: LATER });
  });

  it('never wraps a traversal that is still filling pages, however many it takes', () => {
    // The stable-set case the page ceiling got wrong: ten full pages is not an end, and a set of
    // 2,001 rows needs eleven. The only thing that ends a traversal is reaching its edge.
    let window = sweepWindow(KEY, EDGE);
    for (let page = 1; page <= 40; page++) {
      advanceSweep(KEY, window, at(page), true);
      window = sweepWindow(KEY, LATER);
      expect(window.after).toEqual(at(page));
      expect(window.until).toBe(EDGE);
    }
  });

  it('holds one edge per pass, so one sweep cannot end another traversal', () => {
    const mine = sweepWindow(KEY, EDGE);
    advanceSweep(KEY, mine, at(1), true);

    const other = sweepWindow('aged-holds', LATER);
    advanceSweep('aged-holds', other, at(9), false);

    expect(sweepWindow(KEY, LATER)).toEqual({ after: at(1), until: EDGE });
  });
});
