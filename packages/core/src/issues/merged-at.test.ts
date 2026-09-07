/**
 * ISS-232 — state-machine writer tests for `markMergedIfLeavingBase`.
 *
 * Pure-unit tests using mocked drizzle transactions: the helper decides
 * whether the transition leaves {@link BASE_MERGE_STATE} and stamps
 * `merged_at = now()` idempotently via `WHERE merged_at IS NULL`.
 *
 * The shape of the mocked `tx` mirrors the chainable drizzle API
 * (`tx.update().set().where().returning()`). It no longer needs a `select`
 * chain: the per-project `mergeStates` read this helper used to make was
 * removed with the config key (ISS-863).
 */

import { describe, expect, it, vi } from 'vitest';
import { BASE_MERGE_STATE, markMergedIfLeavingBase, markMergedOnClose } from './merged-at.js';

interface ChainSpec {
  /** Rows the final `.returning()` call should resolve with. */
  returningRows?: Array<{ id: string }>;
}

function buildMockTx(spec: ChainSpec = {}): {
  tx: Parameters<typeof markMergedIfLeavingBase>[0];
  updateCall: ReturnType<typeof vi.fn>;
} {
  const updateCall = vi.fn();
  const update = vi.fn().mockReturnValue({
    set: (...setArgs: unknown[]) => {
      updateCall(...setArgs);
      return {
        where: () => ({
          returning: async () => spec.returningRows ?? [{ id: 'iss-1' }],
        }),
      };
    },
  });
  // biome-ignore lint/suspicious/noExplicitAny: ad-hoc tx shape
  const tx = { update } as any;
  return { tx, updateCall };
}

describe('markMergedIfLeavingBase', () => {
  it('no-ops when transition is into the merge state', async () => {
    const { tx, updateCall } = buildMockTx();
    const result = await markMergedIfLeavingBase(tx, {
      issueId: 'iss-1',
      fromStatus: 'tested',
      toStatus: BASE_MERGE_STATE,
    });
    expect(result.stamped).toBe(false);
    expect(updateCall).not.toHaveBeenCalled();
  });

  it('no-ops when transition stays inside the merge state (NO_OP)', async () => {
    const { tx, updateCall } = buildMockTx();
    const result = await markMergedIfLeavingBase(tx, {
      issueId: 'iss-1',
      fromStatus: BASE_MERGE_STATE,
      toStatus: BASE_MERGE_STATE,
    });
    expect(result.stamped).toBe(false);
    expect(updateCall).not.toHaveBeenCalled();
  });

  it('no-ops when transition does not leave the merge state', async () => {
    const { tx, updateCall } = buildMockTx();
    const result = await markMergedIfLeavingBase(tx, {
      issueId: 'iss-1',
      fromStatus: 'open',
      toStatus: 'confirmed',
    });
    expect(result.stamped).toBe(false);
    expect(updateCall).not.toHaveBeenCalled();
  });

  it('stamps merged_at when transitioning OUT of the default merge state', async () => {
    const { tx, updateCall } = buildMockTx({ returningRows: [{ id: 'iss-1' }] });
    const result = await markMergedIfLeavingBase(tx, {
      issueId: 'iss-1',
      fromStatus: 'released',
      toStatus: 'closed',
    });
    expect(result.stamped).toBe(true);
    expect(updateCall).toHaveBeenCalledOnce();
  });

  it('reports stamped=false when WHERE merged_at IS NULL matches no row (idempotent re-run)', async () => {
    const { tx } = buildMockTx({ returningRows: [] });
    const result = await markMergedIfLeavingBase(tx, {
      issueId: 'iss-1',
      fromStatus: 'released',
      toStatus: 'reopen',
    });
    expect(result.stamped).toBe(false);
  });
});

describe('markMergedOnClose', () => {
  it('no-ops for every non-closed target status', async () => {
    for (const toStatus of ['released', 'waiting', 'reopen', 'on_hold'] as const) {
      const { tx, updateCall } = buildMockTx();
      const result = await markMergedOnClose(tx, { issueId: 'iss-1', toStatus });
      expect(result.stamped).toBe(false);
      expect(updateCall).not.toHaveBeenCalled();
    }
  });

  it('stamps merged_at on close when the column is still NULL', async () => {
    const { tx, updateCall } = buildMockTx({ returningRows: [{ id: 'iss-1' }] });
    const result = await markMergedOnClose(tx, { issueId: 'iss-1', toStatus: 'closed' });
    expect(result.stamped).toBe(true);
    expect(updateCall).toHaveBeenCalledOnce();
  });

  it('reports stamped=false when merged_at is already set (pipeline stamped earlier)', async () => {
    const { tx, updateCall } = buildMockTx({ returningRows: [] });
    const result = await markMergedOnClose(tx, { issueId: 'iss-1', toStatus: 'closed' });
    expect(result.stamped).toBe(false);
    expect(updateCall).toHaveBeenCalledOnce();
  });
});
