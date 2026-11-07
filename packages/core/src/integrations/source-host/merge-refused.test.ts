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
    changeRequestLinkReadings: async () => [],
  }),
  recordDelivery: async () => 'd1',
  updateDelivery,
}));
const merge = vi.fn();
const readChangeRequest = vi.fn(async () => ({
  state: 'open',
  headSha: 'a'.repeat(40),
  baseRef: 'main',
}));
const branchContains = vi.fn(async () => false);
vi.mock('./resolve.js', () => ({
  sourceHostForBinding: async () => ({
    provider: 'github',
    words: { mergeMethods: ['merge'], changeRequest: 'pull request', sigil: '#' },
    merge,
    readChangeRequest,
    branchContains,
  }),
}));
vi.mock('./projection.js', () => ({ markPullRequestMerged: async () => {} }));

const { RefusalError } = await import('../../lib/refusal.js');
const { mergeStoredChangeRequest } = await import('./merge.js');
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

  it('sends nothing and settles refused when the target cannot say whether it holds the head', async () => {
    merge.mockClear();
    branchContains.mockRejectedValueOnce(new Error('GitHub answered HTTP 502 for the compare'));
    const out = await mergeStoredChangeRequest(
      { pullRequestId: 'pr-1', requestedBy: 'user:u1', runId: null },
      stamp as never,
    );
    expect(out).toMatchObject({ kind: 'refused', reason: 'merge-containment-unread' });
    expect(merge).not.toHaveBeenCalled();
    expect(updateDelivery.mock.calls[0]?.[1]).toMatchObject({ status: 'refused' });
  });

  it('refuses a release request whose head is not its pin, before anything is sent', async () => {
    merge.mockClear();
    const out = await mergeStoredChangeRequest(
      {
        pullRequestId: 'pr-1',
        requestedBy: 'user:u1',
        runId: null,
        releasePin: { sha: 'b'.repeat(40), runId: 'r1', pinnedBy: 'approval' },
      },
      stamp as never,
    );
    expect(out).toMatchObject({ kind: 'refused', reason: 'release-head-moved' });
    expect(merge).not.toHaveBeenCalled();
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
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as InstanceType<typeof RefusalError>).refusals[0]?.code).toBe(code);
  });
});
