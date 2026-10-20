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
      from: () => ({ innerJoin: () => ({ where: () => limited }), where: () => limited }),
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
const mark = (kind: string, over: Record<string, unknown> = {}) => ({
  mergedAt: null,
  mergedCommitSha: null,
  mergedLanding: null,
  kind,
  ...over,
});
const SHIPPED = mark('standard', { mergedAt: AT });
const UNSHIPPED = mark('standard');

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
    // ISS-1421 r16 — judge-69 read about 120 words naming `merged_at`; the same short sentences
    // now serve a person and an agent, and the agent's door is a step on a line of its own.
    expect(refusal?.detail).toBe(
      "This issue can't close yet: it is not marked merged. Use Mark merged in the issue's properties, then close it. If it turned out not to be work, move it to Dropped instead.",
    );
    expect(refusal?.detail).not.toMatch(/merged_at|`/);
    expect(refusal?.details).toMatchObject({ requires: 'mergedAt', useInstead: 'dropped' });
    const steps = refusal?.details.steps as Record<string, string> | undefined;
    expect(steps?.merged_mark).toContain('`data.commit`');
    expect(steps?.landing_shape).toContain('Set `landingShape` to `outside_git`');
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
      mark('website', { mergedAt: AT, mergedLanding: 'https://shop.example/products/a' }),
    );
    expect(
      await refuseUnshippedClose(executor, { issueId: 'iss-1', toStatus: 'closed' }),
    ).toBeNull();
  });

  it('permits a close on a merge Forge observed', async () => {
    const { executor } = buildMockExecutor(
      mark('website', { mergedAt: AT, mergedCommitSha: 'abc1234' }),
    );
    expect(
      await refuseUnshippedClose(executor, { issueId: 'iss-1', toStatus: 'closed' }),
    ).toBeNull();
  });

  it('refuses a bare timestamp, naming data.landing as the route', async () => {
    const { executor } = buildMockExecutor(mark('website', { mergedAt: AT }));
    const refusal = await refuseUnshippedClose(executor, { issueId: 'iss-1', toStatus: 'closed' });
    expect(refusal?.detail).toBe(
      "This issue can't close yet: its mark does not say where the work landed. Use Unmark, then Mark merged, and fill in Where it landed. If it turned out not to be work, move it to Dropped instead.",
    );
    expect(refusal?.details).toMatchObject({
      requires: 'mergedLanding',
      shape: 'outside_git',
      declared: false,
      held: 'asserted',
      useInstead: 'dropped',
    });
    const steps = refusal?.details.steps as Record<string, string> | undefined;
    expect(steps?.merged_mark).toMatch(/^Take the mark back with `forge_issues` `unmark` first/);
    expect(steps?.merged_mark).toContain('`data.landing`');
  });

  it('refuses no mark at all with the same route', async () => {
    const { executor } = buildMockExecutor(mark('website'));
    const refusal = await refuseUnshippedClose(executor, { issueId: 'iss-1', toStatus: 'closed' });
    expect(refusal?.detail).toMatch(/^This issue can't close yet: it has no mark saying where/);
    expect(refusal?.detail).toContain('Use Mark merged in the issue');
    expect(refusal?.details).toMatchObject({ requires: 'mergedLanding', held: 'unmarked' });
    expect((refusal?.details.steps as Record<string, string> | undefined)?.merged_mark).toMatch(
      /^Mark it merged with `forge_issues` `mark_merged` carrying `data.landing`/,
    );
  });

  it('refuses by name a project kind nothing writes, rather than guessing its shape', async () => {
    const { executor } = buildMockExecutor(mark('storefront', { mergedAt: AT }));
    await expect(
      refuseUnshippedClose(executor, { issueId: 'iss-1', toStatus: 'closed' }),
    ).rejects.toThrow('project kind `storefront` is not one of');
  });
});
