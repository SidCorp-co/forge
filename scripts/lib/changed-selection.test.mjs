// The case that names this file is `a change the graph cannot reach`: the lane
// that catches it is the one a skip on `selected` alone silently dropped.

import { describe, expect, it } from 'vitest';
import { selectionFor } from './changed-selection.mjs';

const ALL = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'scan.test.ts'];
const SHARE = 0.5;

function select(over) {
  return selectionFor({ all: ALL, selected: [], always: [], fullRunShare: SHARE, ...over });
}

describe('a change the graph cannot reach', () => {
  it('still runs the tests that read the tree', () => {
    const out = select({ selected: [], always: ['scan.test.ts'] });
    expect(out.skip).toBe(false);
    expect(out.files).toEqual(['scan.test.ts']);
  });

  it('skips only when NEITHER lane has anything', () => {
    expect(select({ selected: [], always: [] }).skip).toBe(true);
  });
});

describe('the two lanes are unioned, not preferred', () => {
  it('runs both what the graph reached and what reads the tree', () => {
    const out = select({ selected: ['a.test.ts'], always: ['scan.test.ts'] });
    expect(out.files).toEqual(['a.test.ts', 'scan.test.ts']);
  });

  it('counts a file in both lanes once', () => {
    const out = select({ selected: ['scan.test.ts'], always: ['scan.test.ts'] });
    expect(out.union).toEqual(['scan.test.ts']);
    expect(out.files).toEqual(['scan.test.ts']);
  });
});

describe('past the share the selection has stopped being a saving', () => {
  // cm:guard the whole-suite hand-off is `files: []` because that is what vitest runs with no filter — returning the union instead would run the same files and report a full run, which reads as a saving that was not taken
  it('hands vitest no filter once the union passes the share', () => {
    const out = select({ selected: ['a.test.ts', 'b.test.ts', 'c.test.ts'], always: [] });
    expect(out.full).toBe(true);
    expect(out.files).toEqual([]);
  });

  it('stays a selection at exactly the share, which is not past it', () => {
    const out = select({ selected: ['a.test.ts', 'b.test.ts'], always: [] });
    expect(out.full).toBe(false);
    expect(out.files).toHaveLength(2);
  });

  it('counts the tree-coupled lane toward the share too', () => {
    const out = select({ selected: ['a.test.ts', 'b.test.ts'], always: ['scan.test.ts'] });
    expect(out.full).toBe(true);
  });
});
