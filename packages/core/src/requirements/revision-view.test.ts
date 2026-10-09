// A revision's criteria against the one it was written against (REQ-34 r2 BC-7; Requirement
// lifecycle r15 rev_check): added, reworded and retired codes read from the rows, never typed.

import { describe, expect, it } from 'vitest';
import { type CriterionRow, criteriaChangesOf } from './revision-view.js';

const row = (id: string, code: string, since: number, retired: number | null = null) =>
  ({
    id,
    code,
    body: `${code} at ${since}`,
    form: 'statement',
    sinceRevision: since,
    retiredRevision: retired,
  }) as CriterionRow;

// r1: BC-1, BC-2, BC-3. r2 keeps BC-1, rewords BC-2, retires BC-3, adds BC-4.
const rows = [
  row('a', 'BC-1', 1),
  row('b', 'BC-2', 1, 2),
  row('c', 'BC-3', 1, 2),
  row('d', 'BC-2', 2),
  row('e', 'BC-4', 2),
];

describe('criteriaChangesOf', () => {
  it('names what a revision added, reworded and removed against its base', () => {
    expect(criteriaChangesOf(rows, 2, 1)).toEqual({
      against: 1,
      added: ['BC-4'],
      changed: ['BC-2'],
      removed: ['BC-3'],
    });
  });

  it('is empty for a revision that left every criterion as it stood', () => {
    expect(criteriaChangesOf([row('a', 'BC-1', 1)], 2, 1)).toEqual({
      against: 1,
      added: [],
      changed: [],
      removed: [],
    });
  });

  it('is null for a revision written against nothing', () => {
    expect(criteriaChangesOf(rows, 1, null)).toBeNull();
  });

  it('orders codes by number, not by text', () => {
    const many = [row('x', 'BC-10', 2), row('y', 'BC-9', 2)];
    expect(criteriaChangesOf(many, 2, 1)?.added).toEqual(['BC-9', 'BC-10']);
  });
});
