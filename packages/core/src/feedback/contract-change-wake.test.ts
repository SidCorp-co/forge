import { describe, expect, it, vi } from 'vitest';

// Each awaited query on the transaction takes the next answer: lock, twin, next seq, insert.
const answers: unknown[][] = [];
const chain: unknown = new Proxy(() => {}, {
  get: (_t, p) =>
    p === 'then' ? (res: (v: unknown) => void) => res(answers.shift() ?? []) : () => chain,
});
vi.mock('../db/client.js', () => ({ db: {} }));

const emitted: { type: string; payload: Record<string, unknown> }[] = [];
vi.mock('../outbox/index.js', () => ({
  emitEvent: async (_tx: unknown, type: string, payload: Record<string, unknown>) => {
    emitted.push({ type, payload });
  },
  emitEvents: async () => {},
}));

const { fileContractChangeIn } = await import('./contract-change.js');

const filing = {
  consumerId: 'consumer',
  level: 'standard' as never,
  provider: { id: 'provider', slug: 'shop' },
  contractSlug: 'orders',
  version: '2.0.0',
  breaking: [{ element: 'Order.total', text: 'removed' }],
  dueAt: new Date('2026-11-01T00:00:00Z'),
  filer: { userId: 'u1', agency: 'human' as const },
};

describe('feedback-lifecycle start: a breaking contract change filed on a consumer', () => {
  it('emits feedback.filed with its high severity, so the consumer master is woken', async () => {
    emitted.length = 0;
    answers.push([], [], [{ next: 1 }], [{ id: 'f1', severity: 'high' }]);
    const r = await fileContractChangeIn(chain as never, filing);
    expect(r).toEqual({ id: 'f1', created: true });
    expect(emitted).toEqual([
      {
        type: 'feedback.filed',
        payload: { projectId: 'consumer', feedbackId: 'f1', severity: 'high' },
      },
    ]);
  });

  it('emits nothing when the same version was already filed there', async () => {
    emitted.length = 0;
    answers.push([], [{ id: 'f0' }]);
    const r = await fileContractChangeIn(chain as never, filing);
    expect(r).toEqual({ id: 'f0', created: false });
    expect(emitted).toEqual([]);
  });
});
