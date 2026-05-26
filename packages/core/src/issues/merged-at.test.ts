/**
 * ISS-232 — state-machine writer tests for `markMergedIfLeavingBase`.
 *
 * Pure-unit tests using mocked drizzle transactions; the helper resolves
 * the project's `mergeStates` (defaulting to `released`), decides whether
 * the transition leaves the merge state, and stamps `merged_at = now()`
 * idempotently via `WHERE merged_at IS NULL`.
 *
 * The shape of the mocked `tx` mirrors the chainable drizzle API
 * (`tx.select().from().where().limit()` / `tx.update().set().where().returning()`).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BASE_MERGE_STATE,
  markMergedIfLeavingBase,
  resolveMergeStates,
} from './merged-at.js';

interface ChainSpec {
  agentConfig: unknown;
  /** Rows the final `.returning()` call should resolve with. */
  returningRows?: Array<{ id: string }>;
}

function buildMockTx(spec: ChainSpec): {
  tx: Parameters<typeof markMergedIfLeavingBase>[0];
  updateCall: ReturnType<typeof vi.fn>;
} {
  const select = vi.fn().mockReturnValue({
    from: () => ({
      where: () => ({
        limit: async () => [{ agentConfig: spec.agentConfig }],
      }),
    }),
  });
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
  const tx = { select, update } as any;
  return { tx, updateCall };
}

describe('resolveMergeStates', () => {
  it('defaults baseBranch/productionBranch to "released" when unset', () => {
    expect(resolveMergeStates(null)).toEqual({
      baseBranch: 'released',
      productionBranch: 'released',
    });
    expect(resolveMergeStates({})).toEqual({
      baseBranch: 'released',
      productionBranch: 'released',
    });
  });

  it('accepts agentConfig wrapper form', () => {
    expect(
      resolveMergeStates({
        pipelineConfig: { mergeStates: { baseBranch: 'staging' } },
      }),
    ).toEqual({ baseBranch: 'staging', productionBranch: 'released' });
  });

  it('accepts pipelineConfig (unwrapped) form', () => {
    expect(
      resolveMergeStates({
        mergeStates: { baseBranch: 'developed', productionBranch: 'released' },
      }),
    ).toEqual({ baseBranch: 'developed', productionBranch: 'released' });
  });
});

describe('markMergedIfLeavingBase', () => {
  it('no-ops when transition is into the merge state', async () => {
    const { tx, updateCall } = buildMockTx({ agentConfig: null });
    const result = await markMergedIfLeavingBase(tx, {
      issueId: 'iss-1',
      projectId: 'p-1',
      fromStatus: 'staging',
      toStatus: DEFAULT_BASE_MERGE_STATE,
    });
    expect(result.stamped).toBe(false);
    expect(updateCall).not.toHaveBeenCalled();
  });

  it('no-ops when transition stays inside the merge state (NO_OP)', async () => {
    const { tx, updateCall } = buildMockTx({ agentConfig: null });
    const result = await markMergedIfLeavingBase(tx, {
      issueId: 'iss-1',
      projectId: 'p-1',
      fromStatus: DEFAULT_BASE_MERGE_STATE,
      toStatus: DEFAULT_BASE_MERGE_STATE,
    });
    // fromStatus === baseBranch && toStatus === baseBranch → guard says no.
    expect(result.stamped).toBe(false);
    expect(updateCall).not.toHaveBeenCalled();
  });

  it('no-ops when transition does not leave the merge state', async () => {
    const { tx, updateCall } = buildMockTx({ agentConfig: null });
    const result = await markMergedIfLeavingBase(tx, {
      issueId: 'iss-1',
      projectId: 'p-1',
      fromStatus: 'open',
      toStatus: 'confirmed',
    });
    expect(result.stamped).toBe(false);
    expect(updateCall).not.toHaveBeenCalled();
  });

  it('stamps merged_at when transitioning OUT of the default merge state', async () => {
    const { tx, updateCall } = buildMockTx({
      agentConfig: null,
      returningRows: [{ id: 'iss-1' }],
    });
    const result = await markMergedIfLeavingBase(tx, {
      issueId: 'iss-1',
      projectId: 'p-1',
      fromStatus: 'released',
      toStatus: 'closed',
    });
    expect(result.stamped).toBe(true);
    expect(updateCall).toHaveBeenCalledOnce();
  });

  it('reports stamped=false when WHERE merged_at IS NULL matches no row (idempotent re-run)', async () => {
    const { tx } = buildMockTx({ agentConfig: null, returningRows: [] });
    const result = await markMergedIfLeavingBase(tx, {
      issueId: 'iss-1',
      projectId: 'p-1',
      fromStatus: 'released',
      toStatus: 'reopen',
    });
    expect(result.stamped).toBe(false);
  });

  it('respects operator-overridden mergeStates.baseBranch', async () => {
    const { tx, updateCall } = buildMockTx({
      agentConfig: {
        pipelineConfig: { mergeStates: { baseBranch: 'staging' } },
      },
      returningRows: [{ id: 'iss-1' }],
    });
    // With override, leaving 'released' is NOT the merge transition.
    const noop = await markMergedIfLeavingBase(tx, {
      issueId: 'iss-1',
      projectId: 'p-1',
      fromStatus: 'released',
      toStatus: 'closed',
    });
    expect(noop.stamped).toBe(false);
    expect(updateCall).not.toHaveBeenCalled();

    // Leaving 'staging' IS the merge transition under the override.
    const { tx: tx2, updateCall: updateCall2 } = buildMockTx({
      agentConfig: {
        pipelineConfig: { mergeStates: { baseBranch: 'staging' } },
      },
      returningRows: [{ id: 'iss-1' }],
    });
    const fired = await markMergedIfLeavingBase(tx2, {
      issueId: 'iss-1',
      projectId: 'p-1',
      fromStatus: 'staging',
      toStatus: 'released',
    });
    expect(fired.stamped).toBe(true);
    expect(updateCall2).toHaveBeenCalledOnce();
  });
});
