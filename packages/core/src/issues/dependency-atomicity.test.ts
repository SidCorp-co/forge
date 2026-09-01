/**
 * ISS-889 — the edge write runs on the caller's executor, all of it.
 *
 * `create-service.test.ts` witnesses that the write is CALLED inside the
 * transaction. That is not the same claim as the write actually READING inside
 * it: threading the executor into the insert while leaving `detectCycle` on the
 * module-level pool passes every ordering assertion and still admits the pair
 * the cycle gate exists to refuse, because edges written earlier in the same
 * uncommitted transaction are invisible to a pool read.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_A = '22222222-2222-4222-8222-222222222222';
const ISSUE_B = '33333333-3333-4333-8333-333333333333';

/** Both issues exist and share the project — the shape the sides check wants. */
const SIDES = [
  { id: ISSUE_A, projectId: PROJECT_ID },
  { id: ISSUE_B, projectId: PROJECT_ID },
];

/**
 * The pool sees NO edges: every edge in this test lives only in the pending
 * transaction. A cycle found here therefore proves the walk read the executor.
 */
const poolSelect = vi.fn(() => ({ from: () => ({ where: async () => [] as unknown[] }) }));
vi.mock('../db/client.js', () => ({
  db: { select: poolSelect, transaction: vi.fn() },
}));

vi.mock('../pipeline/hooks.js', () => ({ hooks: { emit: vi.fn(async () => undefined) } }));
vi.mock('../pipeline/activity.js', () => ({ safeRecordActivity: vi.fn(async () => undefined) }));
vi.mock('./pipeline-health.js', () => ({
  publishPipelineHealthChanged: vi.fn(async () => undefined),
}));
vi.mock('./decompose.js', () => ({ decomposeParent: vi.fn(async () => undefined) }));

const { IssueDependencyError, writeIssueDependency } = await import('./dependency-service.js');

const writer = {
  actor: {
    type: 'device' as const,
    id: '44444444-4444-4444-8444-444444444444',
    agency: 'agent' as const,
  },
  createdById: '55555555-5555-4555-8555-555555555555',
};

/**
 * A transaction that already holds `B → A`, uncommitted. `select` answers the
 * sides lookup first, then every `issue_dependencies` walk.
 */
function txHoldingEdgeBtoA() {
  let call = 0;
  return {
    select: vi.fn(() => ({
      from: () => ({
        where: async () => {
          call += 1;
          if (call === 1) return SIDES;
          return [{ to: ISSUE_A }];
        },
      }),
    })),
    insert: vi.fn(() => ({
      values: () => ({ onConflictDoNothing: () => ({ returning: async () => [{ id: 'e1' }] }) }),
    })),
    update: vi.fn(),
  };
}

beforeEach(() => {
  poolSelect.mockClear();
});

describe('writeIssueDependency — the cycle walk reads the caller executor', () => {
  it('refuses A→B when the SAME uncommitted transaction already holds B→A', async () => {
    const tx = txHoldingEdgeBtoA();

    await expect(
      writeIssueDependency(
        { projectId: PROJECT_ID, fromIssueId: ISSUE_A, toIssueId: ISSUE_B, kind: 'blocks' },
        writer,
        tx as never,
      ),
    ).rejects.toMatchObject({ code: 'CYCLE_DETECTED' });

    expect(IssueDependencyError).toBeDefined();
  });

  // cm:guard this is the assertion that fails when only the INSERT is threaded and the walk is left on `db`. Without it, reverting `detectCycle(…, ex)` to `detectCycle(…)` keeps all 369 issues tests green — measured 2026-08-31 — while a create transaction declaring both directions commits a cycle the gate is supposed to refuse.
  it('never reaches the pool for the walk, so an uncommitted edge cannot be missed', async () => {
    const tx = txHoldingEdgeBtoA();

    await expect(
      writeIssueDependency(
        { projectId: PROJECT_ID, fromIssueId: ISSUE_A, toIssueId: ISSUE_B, kind: 'blocks' },
        writer,
        tx as never,
      ),
    ).rejects.toBeInstanceOf(Error);

    expect(poolSelect).not.toHaveBeenCalled();
  });
});
