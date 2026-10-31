// A revision's criteria against the one it was written against (REQ-34 r2 BC-7; Requirement
// lifecycle r15 rev_check): added, reworded and retired codes read from the rows, never typed.

import { describe, expect, it } from 'vitest';
import {
  type CriterionRow,
  criteriaChangesOf,
  type RevisionRow,
  revisionBase,
  revisionView,
} from './revision-view.js';

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

const rev = (revision: number, state: string, baseRevision: number | null, goal: string) =>
  ({
    revision,
    state,
    baseRevision,
    spec: { goal },
    kind: null,
    authorId: 'u',
    createdAt: new Date(0),
    proposedAt: null,
    decidedAt: null,
  }) as unknown as RevisionRow;

describe('the spec a revision changed (REQ-12 BC-19)', () => {
  const revisions = [rev(2, 'proposed', 1, 'new'), rev(1, 'current', null, 'old')];

  it('reads a revision against the one it was written on, else the current one', () => {
    expect(revisionBase(revisions, revisions[0] as RevisionRow, 1)?.revision).toBe(1);
    const unbased = rev(3, 'draft', null, 'x');
    expect(revisionBase([unbased, ...revisions], unbased, 1)?.revision).toBe(1);
    expect(revisionBase([unbased], unbased, null)).toBeNull();
  });

  it('reads a first revision, current or superseded, against nothing, never the current one', () => {
    const first = rev(1, 'superseded', null, 'old');
    const later = [rev(3, 'current', 2, 'now'), rev(2, 'superseded', 1, 'mid'), first];
    expect(revisionBase(later, first, 3)).toBeNull();
    const sole = rev(1, 'current', null, 'only');
    expect(revisionBase([sole], sole, 1)).toBeNull();
    const view = revisionView(first, rows, new Map(), [], revisionBase(later, first, 3));
    expect(view.specChanges.against).toBeNull();
    expect(view.specChanges.goal).toEqual({ before: null, after: 'old' });
  });

  it('serves the field-by-field change with the revision it was read against', () => {
    const [proposed, current] = revisions as [RevisionRow, RevisionRow];
    const view = revisionView(proposed, rows, new Map(), [], current);
    expect(view.specChanges.against).toBe(1);
    expect(view.specChanges.goal).toEqual({ before: 'old', after: 'new' });
    expect(view.specChanges.criteria.map((c) => c.code)).toEqual(['BC-2', 'BC-3', 'BC-4']);
  });
});
