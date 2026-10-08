import { describe, expect, it } from 'vitest';
import { blockerFaults, breakdownFaults } from './rules.js';

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
