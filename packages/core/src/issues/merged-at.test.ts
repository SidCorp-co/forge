import { describe, expect, it, vi } from 'vitest';
import { BASE_MERGE_STATE, refuseUnshippedClose } from './merged-at.js';

function buildMockExecutor(row: Record<string, unknown> | undefined): {
  executor: Parameters<typeof refuseUnshippedClose>[0];
  readCall: ReturnType<typeof vi.fn>;
  updateCall: ReturnType<typeof vi.fn>;
} {
  const readCall = vi.fn();
  const updateCall = vi.fn();
  const select = vi.fn().mockImplementation((...args: unknown[]) => {
    readCall(...args);
    return {
      from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }),
    };
  });
  const update = vi.fn().mockImplementation(() => {
    updateCall();
    return { set: () => ({ where: () => ({ returning: async () => [] }) }) };
  });
  // biome-ignore lint/suspicious/noExplicitAny: ad-hoc executor shape
  const executor = { select, update } as any;
  return { executor, readCall, updateCall };
}

const SHIPPED = { mergedAt: new Date('2026-09-18T00:00:00Z') };
const UNSHIPPED = { mergedAt: null };

describe('refuseUnshippedClose — the statuses it does not judge', () => {
  it.each([
    'waiting',
    'reopen',
    'on_hold',
    'needs_info',
    'in_progress',
    'releasing',
    'dropped',
    BASE_MERGE_STATE,
  ] as const)('%s is not a close, so nothing is read and nothing is refused', async (toStatus) => {
    const { executor, readCall } = buildMockExecutor(UNSHIPPED);
    expect(await refuseUnshippedClose(executor, { issueId: 'iss-1', toStatus })).toBeNull();
    expect(readCall).not.toHaveBeenCalled();
  });
});

describe('refuseUnshippedClose — a close', () => {
  it('permits a close on an issue that carries merged_at', async () => {
    const { executor } = buildMockExecutor(SHIPPED);
    expect(
      await refuseUnshippedClose(executor, { issueId: 'iss-1', toStatus: 'closed' }),
    ).toBeNull();
  });

  it('refuses a close on an issue with no merged_at, and names dropped as the exit', async () => {
    const { executor } = buildMockExecutor(UNSHIPPED);
    const refusal = await refuseUnshippedClose(executor, { issueId: 'iss-1', toStatus: 'closed' });
    expect(refusal).not.toBeNull();
    expect(refusal?.detail).toContain('nothing on it shows the work shipped');
    expect(refusal?.detail).toContain('`dropped`');
    expect(refusal?.details).toMatchObject({ requires: 'mergedAt', useInstead: 'dropped' });
  });

  it('refuses a close on an issue the read cannot find, rather than letting it through', async () => {
    const { executor } = buildMockExecutor(undefined);
    expect(
      await refuseUnshippedClose(executor, { issueId: 'iss-1', toStatus: 'closed' }),
    ).not.toBeNull();
  });

  it('writes nothing — the close no longer stamps merged_at on its way past', async () => {
    const { executor, updateCall } = buildMockExecutor(UNSHIPPED);
    await refuseUnshippedClose(executor, { issueId: 'iss-1', toStatus: 'closed' });
    const { executor: second, updateCall: secondUpdate } = buildMockExecutor(SHIPPED);
    await refuseUnshippedClose(second, { issueId: 'iss-1', toStatus: 'closed' });
    expect(updateCall).not.toHaveBeenCalled();
    expect(secondUpdate).not.toHaveBeenCalled();
  });
});
