import { describe, expect, it, vi } from 'vitest';

const prior = {
  id: 'i1',
  projectId: 'p1',
  status: 'developed',
  mergedAt: null,
  mergedCommitSha: null,
  mergedLanding: null,
};
const stamped = {
  mergedAt: new Date('2026-10-01T00:00:00Z'),
  mergedCommitSha: null,
  mergedLanding: null,
};
// Each awaited query on the transaction takes the next answer: observed merge, prior row, stamp, target.
const answers: unknown[][] = [];
const chain: unknown = new Proxy(() => {}, {
  get: (_t, p) =>
    p === 'then' ? (res: (v: unknown) => void) => res(answers.shift() ?? []) : () => chain,
});
vi.mock('../db/client.js', () => ({
  db: { transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(chain) },
}));

const emitted: { type: string; payload: Record<string, unknown> }[] = [];
vi.mock('../outbox/index.js', () => ({
  emitEvent: async (_tx: unknown, type: string, payload: Record<string, unknown>) => {
    emitted.push({ type, payload });
  },
  emitEvents: async (
    _tx: unknown,
    events: { type: string; payload: Record<string, unknown> }[],
  ) => {
    emitted.push(...events);
  },
}));
vi.mock('./read-service.js', () => ({ findIssueById: async () => prior }));
vi.mock('./ports.js', () => ({
  contractDrift: async () => null,
  postIssueNotice: async (args: { body: string }) => ({
    id: 'c1',
    body: args.body,
    parentId: null,
  }),
}));
vi.mock('./landing-evidence.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readLandingShape: async () => 'git',
}));

const { applyMergeMarker } = await import('./merge-marker.js');

describe('applyMergeMarker: a mark that writes', () => {
  it('emits issue.updated once, and that one names its via', async () => {
    answers.push([], [prior], [stamped], []);
    await applyMergeMarker({
      issue: { id: 'i1', projectId: 'p1', mergedAt: null },
      op: 'mark',
      target: 'dev',
      commit: 'abcdef1',
      actor: {
        agency: 'human',
        commentAuthorId: 'u1',
        hookActor: { type: 'user', id: 'u1', agency: 'human' } as never,
      },
    });
    const updated = emitted.filter((e) => e.type === 'issue.updated');
    expect(updated).toHaveLength(1);
    expect(updated[0]?.payload.via).toBe('mark');
  });
});
