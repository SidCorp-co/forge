/**
 * ISS-232 — Layer-2 dispatch gate is now git-aware. The picker and the
 * single-job asserter both source the predicate from
 * `buildBarrierFragments`, so a SQL-text assertion on either is enough.
 * These tests pin down the contract independent of `dispatch-gates.test.ts`
 * (which already covers picker structure end-to-end) — touching `p.status`
 * is the wrong shape and should never reappear.
 *
 * ISS-639 — the `OR status='closed'` bypass is now CONDITIONAL on the
 * project's `mergeStates.baseBranch` being structurally unstampable (manual
 * mode / auto-toggle off). A default/unconfigured project's base IS
 * stampable, so `closed` alone must NOT satisfy the gate there — only a
 * project whose base can never stamp `merged_at` keeps the bypass. See
 * `dispatch-gates.test.ts` for the full stampable/unstampable matrix; these
 * tests just keep pinned to the default (stampable) case plus one
 * unstampable regression guard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbExecute = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
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

describe('L2 dependency gate — merged_at (ISS-232 / ISS-639)', () => {
  it('picker keys blockedBy on parent.merged_at IS NULL, not parent.status (default project = stampable base)', async () => {
    mockProjectAgentConfigOnce(null);
    dbExecute.mockResolvedValueOnce([]);
    await pickNextDispatchableJobForProject('p1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/d\.kind\s*=\s*'blocks'/);
    expect(text).toMatch(/p\.merged_at\s+IS\s+NULL/);
    // ISS-639 — a default/unconfigured project's baseBranch IS stampable, so
    // `closed` alone must NOT satisfy the gate; only merged_at does.
    expect(text).not.toMatch(/p\.status\s*<>\s*'closed'/);
    expect(text).not.toMatch(/p\.status\s+NOT\s+IN/);
  });

  it('picker keys decomposeChildrenPending on child.merged_at IS NULL (parent waits for children, stampable base)', async () => {
    mockProjectAgentConfigOnce(null);
    dbExecute.mockResolvedValueOnce([]);
    await pickNextDispatchableJobForProject('p1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/d2\.kind\s*=\s*'decomposes'/);
    // The job's issue is the PARENT (d2.from_issue_id = j.issue_id); the gate
    // keys on the CHILD's merged_at (c2), not the parent's.
    expect(text).toMatch(/d2\.from_issue_id\s*=\s*j\.issue_id/);
    expect(text).toMatch(/c2\.merged_at\s+IS\s+NULL/);
    expect(text).not.toMatch(/c2\.status\s*<>\s*'closed'/);
    expect(text).not.toMatch(/c2\.status\s+NOT\s+IN/);
  });

  it('asserter mirrors picker — same merged_at clauses, no status compare (stampable base)', async () => {
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
    expect(text).toMatch(/c2\.merged_at\s+IS\s+NULL/);
    expect(text).not.toMatch(/p\.status\s*<>\s*'closed'/);
    expect(text).not.toMatch(/c2\.status\s*<>\s*'closed'/);
    expect(text).not.toMatch(/p\.status\s+NOT\s+IN/);
    expect(text).not.toMatch(/c2\.status\s+NOT\s+IN/);
  });

  // ISS-639 regression guard (commit d6e377c1) — a project whose baseBranch
  // is structurally unstampable (manual mode) must keep the `closed` bypass
  // so a sibling-`blocks` chain doesn't deadlock forever.
  it('picker keeps the closed bypass when the base branch is structurally unstampable (manual mode)', async () => {
    mockProjectAgentConfigOnce({
      pipelineConfig: {
        mergeStates: { baseBranch: 'released' },
        states: { released: { mode: 'manual' } },
      },
    });
    dbExecute.mockResolvedValueOnce([]);
    await pickNextDispatchableJobForProject('p1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(
      /\(\s*p\.merged_at\s+IS\s+NULL\s+OR\s+p\.status\s*=\s*'reopen'\s*\)\s+AND\s+p\.status\s*<>\s*'closed'/,
    );
    expect(text).toMatch(
      /\(\s*c2\.merged_at\s+IS\s+NULL\s+OR\s+c2\.status\s*=\s*'reopen'\s*\)\s+AND\s+c2\.status\s*<>\s*'closed'/,
    );
  });

  // sid-desk ISS-20/25 — `merged_at` is COALESCE-once and survives a later
  // reopen, so a child that reached `tested` then failed QA still read as
  // satisfied and dispatched its parent onto broken staging. Both arms must
  // treat a currently-reopened blocker as unsatisfied regardless of the stamp.
  it('treats a reopened blocker/child as unsatisfied even when merged_at is stamped', async () => {
    mockProjectAgentConfigOnce({});
    dbExecute.mockResolvedValueOnce([]);
    await pickNextDispatchableJobForProject('p1');
    const text = collectSqlFragments(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/p\.merged_at\s+IS\s+NULL\s+OR\s+p\.status\s*=\s*'reopen'/);
    expect(text).toMatch(/c2\.merged_at\s+IS\s+NULL\s+OR\s+c2\.status\s*=\s*'reopen'/);
    // Only `reopen` — widening to on_hold/needs_info would silently wedge queues.
    expect(text).not.toMatch(/p\.status\s*=\s*'on_hold'/);
    expect(text).not.toMatch(/p\.status\s*=\s*'needs_info'/);
  });
});
