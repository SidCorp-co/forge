/**
 * ISS-232 — Layer-2 dispatch gate is now git-aware. The picker and the
 * single-job asserter both source the predicate from
 * `buildBarrierFragments`, so a SQL-text assertion on either is enough.
 * These tests pin down the contract independent of `dispatch-gates.test.ts`
 * (which already covers picker structure end-to-end) — touching `p.status`
 * is the wrong shape and should never reappear.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbExecute = vi.fn(async () => [] as unknown[]);
const dbSelect = vi.fn();

vi.mock('../db/client.js', () => ({
  db: { execute: dbExecute, select: dbSelect },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { pickNextDispatchableJobForProject, assertDispatchable } = await import(
  './dispatch-gates.js'
);

function collectSqlFragments(sqlArg: unknown): string {
  const fragments: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      fragments.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node && typeof node === 'object') {
      const value = (node as { value?: unknown }).value;
      if (typeof value === 'string') fragments.push(value);
      else if (Array.isArray(value)) visit(value);
      const chunks = (node as { queryChunks?: unknown }).queryChunks;
      if (chunks) visit(chunks);
    }
  };
  visit(sqlArg);
  return fragments.join(' ');
}

function mockProjectAgentConfigOnce(value: Record<string, unknown> | null): void {
  dbSelect.mockImplementationOnce(() => ({
    from: () => ({
      where: () => ({ limit: async () => [{ agentConfig: value }] }),
    }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('L2 dependency gate — merged_at (ISS-232)', () => {
  it('picker keys blockedBy on parent.merged_at IS NULL, not parent.status', async () => {
    mockProjectAgentConfigOnce(null);
    dbExecute.mockResolvedValueOnce([]);
    await pickNextDispatchableJobForProject('p1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/d\.kind\s*=\s*'blocks'/);
    expect(text).toMatch(/p\.merged_at\s+IS\s+NULL/);
    expect(text).not.toMatch(/p\.status\s+NOT\s+IN/);
  });

  it('picker keys releaseDecomposePending on parent2.merged_at IS NULL', async () => {
    mockProjectAgentConfigOnce(null);
    dbExecute.mockResolvedValueOnce([]);
    await pickNextDispatchableJobForProject('p1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/d2\.kind\s*=\s*'decomposes'/);
    expect(text).toMatch(/p2\.merged_at\s+IS\s+NULL/);
    expect(text).not.toMatch(/p2\.status\s+NOT\s+IN/);
  });

  it('asserter mirrors picker — same merged_at clauses, no status compare', async () => {
    // First select fetches the job; second fetches the project's agentConfig.
    dbSelect
      .mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({ limit: async () => [{ projectId: 'p1' }] }),
        }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({ limit: async () => [{ agentConfig: null }] }),
        }),
      }));
    dbExecute.mockResolvedValueOnce([{ reason: null }]);
    await assertDispatchable('job-1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/p\.merged_at\s+IS\s+NULL/);
    expect(text).toMatch(/p2\.merged_at\s+IS\s+NULL/);
    expect(text).not.toMatch(/p\.status\s+NOT\s+IN/);
    expect(text).not.toMatch(/p2\.status\s+NOT\s+IN/);
  });
});
