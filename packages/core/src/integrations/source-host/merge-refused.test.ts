import { beforeEach, describe, expect, it, vi } from 'vitest';

const row = {
  id: 'pr-1',
  projectId: 'p1',
  bindingId: 'b1',
  issueId: 'i1',
  number: 7,
  state: 'open',
};
const chain: unknown = new Proxy(() => {}, {
  get: (_t, p) => (p === 'then' ? (res: (v: unknown) => void) => res([row]) : () => chain),
});
vi.mock('../../db/client.js', () => ({ db: chain }));

const updateDelivery = vi.fn(async (_id: string, _patch: Record<string, unknown>) => {});
vi.mock('../index.js', () => ({
  forgeReads: () => ({
    runProjectOf: async (runId: string) => (runId === 'r-other' ? 'p2' : null),
  }),
  recordDelivery: async () => 'd1',
  updateDelivery,
}));
const merge = vi.fn();
vi.mock('./resolve.js', () => ({
  sourceHostForBinding: async () => ({
    provider: 'github',
    words: { mergeMethods: ['merge'], changeRequest: 'pull request', sigil: '#' },
    merge,
  }),
}));
vi.mock('./projection.js', () => ({ markPullRequestMerged: async () => {} }));

const { MergeInputError, mergeStoredChangeRequest } = await import('./merge.js');
const stamp = async () => ({ wrote: true });

describe('mergeStoredChangeRequest: a refused merge', () => {
  beforeEach(() => updateDelivery.mockClear());

  it('settles its delivery refused when the host refuses', async () => {
    merge.mockResolvedValueOnce({ kind: 'refused', reason: 'head-moved', detail: 'head moved' });
    const out = await mergeStoredChangeRequest(
      { pullRequestId: 'pr-1', requestedBy: 'user:u1', runId: null },
      stamp as never,
    );
    expect(out?.kind).toBe('refused');
    expect(updateDelivery.mock.calls[0]?.[1]).toMatchObject({ status: 'refused' });
  });

  it('settles its delivery refused on a method the host lacks', async () => {
    await mergeStoredChangeRequest(
      { pullRequestId: 'pr-1', requestedBy: 'user:u1', runId: null, method: 'rebase' },
      stamp as never,
    );
    expect(updateDelivery.mock.calls[0]?.[1]).toMatchObject({ status: 'refused' });
  });

  it.each([
    [{ requestedBy: ' ', runId: null }, 'MERGE_REQUESTER_MISSING'],
    [{ requestedBy: 'user:u1', runId: 'r-none' }, 'MERGE_RUN_NOT_FOUND'],
    [{ requestedBy: 'user:u1', runId: 'r-other' }, 'MERGE_RUN_OF_ANOTHER_PROJECT'],
  ])('a caller-input fault %o carries its code %s', async (req, code) => {
    const err = await mergeStoredChangeRequest(
      { pullRequestId: 'pr-1', ...req },
      stamp as never,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MergeInputError);
    expect((err as { code?: string }).code).toBe(code);
  });
});
