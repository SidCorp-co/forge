import { describe, expect, it } from 'vitest';
import { ambiguousDetail, matchCriteria } from './match.js';

// ISS-567 (FB-138): a write matched live rows by (number, wording), so a criterion that only moved
// was retired and re-added and the verdicts it earned stopped counting. Wording is matched first now.

const row = (id: string, n: number, statement: string) => ({ id, n, statement });
const ids = (m: ReturnType<typeof matchCriteria<ReturnType<typeof row>>>) =>
  [...m.kept.entries()].sort(([a], [b]) => a - b).map(([i, r]) => [i, r.id]);

describe('matchCriteria', () => {
  it('keeps a row whose wording moved to another number', () => {
    const live = [row('a', 1, 'Nurse'), row('b', 2, 'Doctor')];
    const m = matchCriteria(live, [
      { n: 1, statement: 'Patient' },
      { n: 2, statement: 'Nurse' },
      { n: 3, statement: 'Doctor' },
    ]);
    expect(ids(m)).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(m.retired).toEqual([]);
    expect(m.ambiguous).toEqual([]);
  });

  it('keeps both rows of a swap, and reads a re-wrap as the same wording', () => {
    const live = [row('a', 1, 'Nurse sees it'), row('b', 2, 'Doctor')];
    const m = matchCriteria(live, [
      { n: 1, statement: 'Doctor' },
      { n: 2, statement: 'Nurse\n  sees it' },
    ]);
    expect(ids(m)).toEqual([
      [0, 'b'],
      [1, 'a'],
    ]);
  });

  it('retires a reworded row and a removed one', () => {
    const live = [row('a', 1, 'Nurse'), row('b', 2, 'Doctor'), row('c', 3, 'Patient')];
    const m = matchCriteria(live, [
      { n: 1, statement: 'Doctor' },
      { n: 2, statement: 'Nurse within a minute' },
    ]);
    expect(ids(m)).toEqual([[0, 'b']]);
    expect(m.retired.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('keeps a repeated wording at its own numbers', () => {
    const live = [row('a', 1, 'Nurse'), row('b', 2, 'Nurse')];
    const m = matchCriteria(live, [
      { n: 1, statement: 'Nurse' },
      { n: 2, statement: 'Nurse' },
      { n: 3, statement: 'Doctor' },
    ]);
    expect(ids(m)).toEqual([
      [0, 'a'],
      [1, 'b'],
    ]);
    expect(m.ambiguous).toEqual([]);
  });

  it('reports a repeated wording that would have to move, on either side, and guesses nothing', () => {
    const twiceWanted = matchCriteria(
      [row('a', 1, 'Nurse'), row('b', 2, 'Doctor')],
      [
        { n: 1, statement: 'Doctor' },
        { n: 2, statement: 'Nurse' },
        { n: 3, statement: 'Nurse' },
      ],
    );
    const twiceLive = matchCriteria(
      [row('a', 1, 'Nurse'), row('b', 2, 'Nurse')],
      [
        { n: 2, statement: 'Nurse' },
        { n: 3, statement: 'Nurse' },
      ],
    );
    expect(twiceWanted.ambiguous).toEqual([{ statement: 'Nurse', live: [1], desired: [2, 3] }]);
    expect(twiceLive.ambiguous).toEqual([{ statement: 'Nurse', live: [1], desired: [3] }]);
    expect(ambiguousDetail(twiceWanted.ambiguous)).toContain(
      'criteria 2 and 3 would carry the wording of live criterion 1',
    );
  });

  it('retires a repeated wording that only shrank, as nothing has to move', () => {
    const m = matchCriteria(
      [row('a', 1, 'Nurse'), row('b', 2, 'Nurse')],
      [{ n: 1, statement: 'Nurse' }],
    );
    expect(ids(m)).toEqual([[0, 'a']]);
    expect(m.retired.map((r) => r.id)).toEqual(['b']);
    expect(m.ambiguous).toEqual([]);
  });
});
