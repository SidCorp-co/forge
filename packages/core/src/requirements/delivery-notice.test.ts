import { beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  phase: 'delivered' as string | null,
  emitted: [] as { type: string; payload: unknown }[],
}));

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ innerJoin: () => ({ where: async () => (state.row ? [state.row] : []) }) }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  },
}));
vi.mock('./acceptance.js', () => ({
  deliveryIn: async () => ({ delivery: { phase: state.phase } }),
}));
vi.mock('../outbox/index.js', async () => {
  const consumers = await import('../outbox/consumers.js');
  return {
    consume: consumers.consume,
    emitEvent: async (_tx: unknown, type: string, payload: unknown) => {
      state.emitted.push({ type, payload });
    },
  };
});

const { consumerOf } = await import('../outbox/consumers.js');
const { registerRequirementDelivery } = await import('./delivery-notice.js');

const agreed = {
  id: 'r1',
  projectId: 'p1',
  reqSeq: 3,
  title: 'Export',
  status: 'agreed',
  currentRevision: 2,
};
const move = (to: string) => ({ entity: 'issue', id: 'i1', projectId: 'p1', to }) as never;

describe('the requirement.delivered notice', () => {
  beforeAll(() => registerRequirementDelivery());
  const handle = (to: string) =>
    consumerOf('issue.transitioned', 'requirement-delivery')?.handle(move(to), {} as never);

  it('is told when a linked issue closing leaves its agreed requirement reading delivered', async () => {
    state.row = agreed;
    state.phase = 'delivered';
    state.emitted = [];
    await handle('closed');
    expect(state.emitted).toEqual([
      {
        type: 'requirement.delivered',
        payload: {
          projectId: 'p1',
          requirementId: 'r1',
          key: 'REQ-3',
          title: 'Export',
          revision: 2,
        },
      },
    ]);
  });

  it('is told when the last unshipped issue is dropped', async () => {
    state.emitted = [];
    await handle('dropped');
    expect(state.emitted).toHaveLength(1);
  });

  it('is not told while the phase reads in_delivery, for a move that cannot complete it, or for an unlinked issue', async () => {
    state.emitted = [];
    state.phase = 'in_delivery';
    await handle('closed');
    state.phase = 'delivered';
    await handle('in_progress');
    state.row = null;
    await handle('closed');
    state.row = { ...agreed, status: 'accepted' };
    await handle('closed');
    expect(state.emitted).toEqual([]);
  });
});
