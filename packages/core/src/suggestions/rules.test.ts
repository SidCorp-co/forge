import { describe, expect, it } from 'vitest';
import {
  baseStaleRefusal,
  blockerFaults,
  breakdownFaults,
  supersedesUnknownRefusal,
} from './rules.js';

// ISS-281's judge: splitting `blockerFaults` out of `breakdownFaults` kept the refusal order only by
// reading, and no test pinned it. A breakdown's propose and accept refuse in this order — the edge
// that closes a cycle first, then slice by slice its untraced criteria before its bad blocker
// indices — and the breakdown read shows the same refusals, so the first one named stays the same.

type Breakdown = Parameters<typeof breakdownFaults>[0];

const slice = (tracesTo: string[], blockedBy: (number | string)[] = []) => ({
  title: `slice ${tracesTo.join('+')}`,
  criteria: tracesTo.map((code) => ({ body: `proves ${code}`, tracesTo: code })),
  blockedBy,
  complexity: 's' as const,
});

const codes = new Map([['BC-1', {}]]);

describe("a breakdown's refusals, in the order its accept names them", () => {
  it('names the cycle first, then each slice: its untraced criteria before its bad blockers', () => {
    const p = {
      issues: [slice(['BC-9'], [1, 0]), slice(['BC-1', 'BC-8'], [0, 7]), slice(['BC-7'], [2])],
    } as unknown as Breakdown;
    expect(breakdownFaults(p, codes, 3).map((r) => r.path)).toEqual([
      '/payload/issues/1/blockedBy/0',
      '/payload/issues/0/criteria/0/tracesTo',
      '/payload/issues/0/blockedBy/1',
      '/payload/issues/1/criteria/1/tracesTo',
      '/payload/issues/1/blockedBy/1',
      '/payload/issues/2/criteria/0/tracesTo',
      '/payload/issues/2/blockedBy/0',
    ]);
  });

  it('names the same blocker refusals, in the same order, as the read of the breakdown shows', () => {
    const p = {
      issues: [slice(['BC-1'], [1, 0]), slice(['BC-1'], [0, 7]), slice(['BC-1'], [2])],
    } as unknown as Breakdown;
    expect(breakdownFaults(p, codes, 3)).toEqual(blockerFaults(p));
  });
});

// FB-152: a number sent against a target that holds no revision was answered "the target's head is
// no revision ... propose against it", and callers tried 0 and 1 before null. The refusal names null.
describe('the stale-base refusal on a target with no revision', () => {
  it('tells the caller to send baseRevision: null, whatever number it sent', () => {
    for (const base of [1, 2, 7]) {
      const r = baseStaleRefusal(base, null);
      expect(r?.code).toBe('SUGGESTION_BASE_STALE');
      expect(r?.path).toBe('/baseRevision');
      expect(r?.detail).toContain(`based on revision ${base}`);
      expect(r?.detail).toContain('send baseRevision: null, not a revision number');
    }
  });

  it('takes null there, and a revisioned head still names its revision, not null', () => {
    expect(baseStaleRefusal(null, null)).toBeNull();
    expect(baseStaleRefusal(3, 3)).toBeNull();
    const moved = baseStaleRefusal(2, 3);
    expect(moved?.detail).toContain("the target's head is revision 3");
    expect(moved?.detail).not.toContain('null');
  });

  it('an open revision a revision_diff builds on is named instead of null', () => {
    const r = baseStaleRefusal(null, null, { revision: 1, state: 'draft' });
    expect(r?.detail).toContain('propose against revision 1');
    expect(r?.detail).not.toContain('baseRevision: null');
  });
});

// ISS-568: a suggestion names the one it supersedes among its own project's; another project's id is
// refused exactly as an id that exists nowhere, so the answer confirms nothing about it.
describe('the suggestion a new one supersedes', () => {
  it('none named, or one the project holds, passes', () => {
    expect(supersedesUnknownRefusal(null, false)).toBeNull();
    expect(supersedesUnknownRefusal('6f0c1b52-6a0e-4c3a-9a51-0d1f6b7b2a10', true)).toBeNull();
  });

  it('one the project does not hold is refused by name at /supersedes, naming what is valid', () => {
    const r = supersedesUnknownRefusal('6f0c1b52-6a0e-4c3a-9a51-0d1f6b7b2a10', false);
    expect(r?.code).toBe('SUGGESTION_SUPERSEDES_UNKNOWN');
    expect(r?.path).toBe('/supersedes');
    expect(r?.detail).toContain('an earlier suggestion of the same project');
  });
});
