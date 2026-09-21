import { describe, expect, it, vi } from 'vitest';
import { BASE_MERGE_STATE, markMergedOnClose } from './merged-at.js';

interface ChainSpec {
  /** Rows the final `.returning()` call resolves with. Empty means the WHERE matched nothing. */
  returningRows?: Array<Record<string, unknown>>;
  /** What the read-back finds when the write matched nothing. */
  heldRow?: Record<string, unknown> | undefined;
}

function buildMockTx(spec: ChainSpec = {}): {
  tx: Parameters<typeof markMergedOnClose>[0];
  updateCall: ReturnType<typeof vi.fn>;
} {
  const updateCall = vi.fn();
  const update = vi.fn().mockReturnValue({
    set: (...setArgs: unknown[]) => {
      updateCall(...setArgs);
      return {
        where: () => ({
          returning: async () =>
            spec.returningRows ?? [
              { mergedAt: new Date('2026-09-18T00:00:00Z'), mergedCommitSha: null },
            ],
        }),
      };
    },
  });
  const select = vi.fn().mockReturnValue({
    from: () => ({ where: () => ({ limit: async () => (spec.heldRow ? [spec.heldRow] : []) }) }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: ad-hoc tx shape
  const tx = { update, select } as any;
  return { tx, updateCall };
}

describe('leaving the base merge state', () => {
  it.each([
    'waiting',
    'reopen',
    'on_hold',
    'needs_info',
    'in_progress',
    'releasing',
    'dropped',
  ] as const)('awaiting_release -> %s reaches no stamp at all', async (toStatus) => {
    const { tx, updateCall } = buildMockTx();
    const result = await markMergedOnClose(tx, { issueId: 'iss-1', toStatus });
    expect(result.stamped).toBe(false);
    expect(updateCall).not.toHaveBeenCalled();
  });

  it('entering the base merge state reaches no stamp', async () => {
    const { tx, updateCall } = buildMockTx();
    const result = await markMergedOnClose(tx, { issueId: 'iss-1', toStatus: BASE_MERGE_STATE });
    expect(result.stamped).toBe(false);
    expect(updateCall).not.toHaveBeenCalled();
  });
});

describe('markMergedOnClose', () => {
  it('no-ops for every non-closed target status', async () => {
    for (const toStatus of ['awaiting_release', 'waiting', 'reopen', 'on_hold'] as const) {
      const { tx, updateCall } = buildMockTx();
      const result = await markMergedOnClose(tx, { issueId: 'iss-1', toStatus });
      expect(result.stamped).toBe(false);
      expect(updateCall).not.toHaveBeenCalled();
    }
  });

  it('stamps merged_at on close when the column is still NULL', async () => {
    const { tx, updateCall } = buildMockTx();
    const result = await markMergedOnClose(tx, { issueId: 'iss-1', toStatus: 'closed' });
    expect(result.stamped).toBe(true);
    expect(updateCall).toHaveBeenCalledOnce();
  });

  it('writes no commit sha, because a close observes no merge', async () => {
    const { tx, updateCall } = buildMockTx();
    await markMergedOnClose(tx, { issueId: 'iss-1', toStatus: 'closed' });
    const written = updateCall.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written).not.toHaveProperty('mergedCommitSha');
  });

  it('reports stamped=false when merged_at is already set (an earlier writer got there)', async () => {
    const { tx, updateCall } = buildMockTx({
      returningRows: [],
      heldRow: { mergedAt: new Date('2026-09-01T00:00:00Z'), mergedCommitSha: 'abc1234' },
    });
    const result = await markMergedOnClose(tx, { issueId: 'iss-1', toStatus: 'closed' });
    expect(result.stamped).toBe(false);
    expect(updateCall).toHaveBeenCalledOnce();
  });
});
