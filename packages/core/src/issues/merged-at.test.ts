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
    const limited = { limit: async () => (row ? [row] : []) };
    return {
      from: () => ({ leftJoin: () => ({ where: () => limited }), where: () => limited }),
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

const AT = new Date('2026-09-18T00:00:00Z');
const mark = (sourceType: string | null, over: Record<string, unknown> = {}) => ({
  mergedAt: null,
  mergedCommitSha: null,
  mergedLanding: null,
  sourceType,
  ...over,
});
const SHIPPED = mark('git', { mergedAt: AT });
const UNSHIPPED = mark('git');

describe('refuseUnshippedClose — the statuses it does not judge', () => {
  it.each([
    'reopen',
    'on_hold',
    'needs_info',
    'in_progress',
    'approved',
    'dropped',
    BASE_MERGE_STATE,
  ] as const)('%s is not a close, so nothing is read and nothing is refused', async (toStatus) => {
    const { executor, readCall } = buildMockExecutor(UNSHIPPED);
    expect(await refuseUnshippedClose(executor, { issueId: 'iss-1', toStatus })).toBeNull();
    expect(readCall).not.toHaveBeenCalled();
  });
});

describe('refuseUnshippedClose — a close on a project that lands in git', () => {
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
    expect(refusal?.detail).toContain('`mark_merged` naming where it landed');
    expect(refusal?.detail).not.toContain('landing');
    expect(refusal?.details).toEqual({ requires: 'mergedAt', useInstead: 'dropped' });
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

describe('refuseUnshippedClose — a close on a project whose work lands outside git', () => {
  it('permits a close on a mark naming where the work landed', async () => {
    const { executor } = buildMockExecutor(
      mark('storefront', { mergedAt: AT, mergedLanding: 'https://shop.example/products/a' }),
    );
    expect(
      await refuseUnshippedClose(executor, { issueId: 'iss-1', toStatus: 'closed' }),
    ).toBeNull();
  });

  it('permits a close on a merge Forge observed', async () => {
    const { executor } = buildMockExecutor(
      mark('storefront', { mergedAt: AT, mergedCommitSha: 'abc1234' }),
    );
    expect(
      await refuseUnshippedClose(executor, { issueId: 'iss-1', toStatus: 'closed' }),
    ).toBeNull();
  });

  it('refuses a bare timestamp, naming data.landing as the route', async () => {
    const { executor } = buildMockExecutor(mark('storefront', { mergedAt: AT }));
    const refusal = await refuseUnshippedClose(executor, { issueId: 'iss-1', toStatus: 'closed' });
    expect(refusal?.detail).toContain('names no landing');
    expect(refusal?.detail).not.toMatch(
      /merged pull request|merged_commit_sha|CLAIM Forge did not observe/,
    );
    expect(refusal?.detail).toContain('`data.landing`');
    expect(refusal?.details).toEqual({
      requires: 'mergedLanding',
      shape: 'outside_git',
      held: 'asserted',
      useInstead: 'dropped',
    });
  });

  it('refuses no mark at all with the same route', async () => {
    const { executor } = buildMockExecutor(mark('storefront'));
    const refusal = await refuseUnshippedClose(executor, { issueId: 'iss-1', toStatus: 'closed' });
    expect(refusal?.detail).toContain('no merged mark');
    expect(refusal?.detail).toContain('`data.landing`');
    expect(refusal?.details).toMatchObject({ requires: 'mergedLanding', held: 'unmarked' });
  });

  it('refuses by name a source type no schema admits, rather than guessing its shape', async () => {
    const { executor } = buildMockExecutor(mark('website', { mergedAt: AT }));
    await expect(
      refuseUnshippedClose(executor, { issueId: 'iss-1', toStatus: 'closed' }),
    ).rejects.toThrow('source.type `website` is not one of');
  });
});

describe('refuseUnshippedClose — a close on a project with no project document', () => {
  it('permits a close on a merge Forge observed, which every shape accepts', async () => {
    const { executor } = buildMockExecutor(
      mark(null, { mergedAt: AT, mergedCommitSha: 'abc1234' }),
    );
    expect(
      await refuseUnshippedClose(executor, { issueId: 'iss-1', toStatus: 'closed' }),
    ).toBeNull();
  });

  it('refuses a bare claim by naming the source.type it cannot judge it without', async () => {
    const { executor } = buildMockExecutor(mark(null, { mergedAt: AT }));
    const refusal = await refuseUnshippedClose(executor, { issueId: 'iss-1', toStatus: 'closed' });
    expect(refusal?.detail).toContain('declares no project document');
    expect(refusal?.detail).toContain('PUT /api/projects/:id/config');
    expect(refusal?.details).toEqual({
      requires: 'sourceType',
      held: 'asserted',
      useInstead: 'dropped',
    });
  });
});
