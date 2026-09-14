// Which handle the fact-gathering reads through, and when it reads at all.
//
// Every read here can run inside a caller's open transaction — `insertComment`
// screens before its own insert — and the pool is ten wide. A read that falls
// back to the pool while its caller holds a connection waits for a second one,
// and ten concurrent writers then wait on each other until they time out. That
// is the deadlock `loadStageContext` carries a guard about (ISS-981), and the
// executor's contract is what defends against it.

import { describe, expect, it, vi } from 'vitest';

const poolExecute = vi.fn();
const poolSelect = vi.fn();
vi.mock('../db/client.js', () => ({
  db: { execute: poolExecute, select: poolSelect },
}));

const progressCalls: unknown[] = [];
vi.mock('../issues/progress.js', () => ({
  computeProjectProgress: async (_projectId: string, dbi: unknown) => {
    progressCalls.push(dbi);
    return { shipped: 1, total: 2 };
  },
}));

const prefixCalls: unknown[] = [];
vi.mock('../issues/issue-prefix-read.js', () => ({
  activeIssuePrefix: async (_projectId: string, dbi: unknown) => {
    prefixCalls.push(dbi);
    return 'ISS';
  },
  heldIssuePrefixes: async (_projectId: string, dbi: unknown) => {
    prefixCalls.push(dbi);
    return [];
  },
}));

const { gatherFacts } = await import('./gather.js');

/** A stand-in for a caller's open transaction: recognisable, and not the pool. */
const TX = {
  marker: 'the caller transaction',
  select: () => ({
    from: () => ({ where: async () => [] }),
  }),
  execute: async () => [],
} as never;

describe('gathering facts inside a caller transaction', () => {
  it('reads the prefixes through the executor it was given', async () => {
    prefixCalls.length = 0;
    await gatherFacts({
      projectId: 'p1',
      audience: 'public',
      intent: 'report',
      segments: ['ISS-42 is merged'],
      executor: TX,
    });
    expect(prefixCalls.length).toBeGreaterThan(0);
    for (const call of prefixCalls) expect(call).toBe(TX);
    expect(poolSelect).not.toHaveBeenCalled();
  });

  // cm:guard this was the one that got away, and it is the reason the test exists rather than a guard alone: the prefix and issue reads were threaded through and the PROGRESS read was not, because no cell needing progress is screened inside a transaction today. The executor's contract is what must hold, not the current call graph (ISS-997 review, F2).
  it('reads the progress through it too, not through the pool', async () => {
    progressCalls.length = 0;
    await gatherFacts({
      projectId: 'p1',
      audience: 'public',
      intent: 'report',
      segments: ['we are 1 of 2 done'],
      progress: 'compute',
      executor: TX,
    });
    expect(progressCalls).toEqual([TX]);
    expect(poolExecute).not.toHaveBeenCalled();
  });

  // cm:guard the short-circuit is what keeps the common comment free: a body naming no issue at all must make NO query, because `insertComment` runs this on every agent comment and most of them cite nothing.
  it('makes no query at all for a body naming no issue', async () => {
    prefixCalls.length = 0;
    poolSelect.mockClear();
    const facts = await gatherFacts({
      projectId: 'p1',
      audience: 'role',
      intent: 'report',
      segments: ['still working on the refactor, nothing to report yet'],
      executor: TX,
    });
    expect(prefixCalls).toEqual([]);
    expect(poolSelect).not.toHaveBeenCalled();
    expect(facts.prefix).toBeNull();
  });
});
