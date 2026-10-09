import { beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  candidates: [] as Record<string, unknown>[],
  phase: 'delivered' as string | null,
  /** `requirementId@revision` the outbox already holds a requirement.delivered event for. */
  raised: new Set<string>(),
  failRead: false,
  emitted: [] as { type: string; payload: unknown }[],
}));

/** The statement's text, its parameters dropped, so a fake can tell which query it was sent. */
function textOf(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((c) =>
      c && typeof c === 'object' && 'value' in c ? String((c as { value: unknown }).value) : '',
    )
    .join(' ');
}
function paramsOf(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.filter((c) => typeof c === 'string' || typeof c === 'number');
}

const execute = async (query: unknown) => {
  const text = textOf(query);
  if (text.includes('FROM requirements r')) return state.candidates;
  if (text.includes('pg_advisory_xact_lock')) return [];
  if (text.includes('FROM pipeline_outbox')) {
    const [id, revision] = paramsOf(query);
    return state.raised.has(`${id}@${revision}`) ? [{ one: 1 }] : [];
  }
  throw new Error(`unexpected statement: ${text}`);
};

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ innerJoin: () => ({ where: async () => (state.row ? [state.row] : []) }) }),
    }),
    execute,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute }),
  },
}));
vi.mock('./acceptance.js', () => ({
  deliveryIn: async (_ex: unknown, _project: string, row: { id: string }) => {
    if (state.failRead && row.id === 'r1') throw new Error('production probe timed out');
    return { delivery: { phase: state.phase } };
  },
  liveBuildOfRequirement: async () => null,
}));
vi.mock('../outbox/index.js', async () => {
  const consumers = await import('../outbox/consumers.js');
  return {
    consume: consumers.consume,
    emitEvent: async (
      _tx: unknown,
      type: string,
      payload: { requirementId: string; revision: number },
    ) => {
      state.emitted.push({ type, payload });
      state.raised.add(`${payload.requirementId}@${payload.revision}`);
    },
  };
});

const { consumerOf } = await import('../outbox/consumers.js');
const { registerRequirementDelivery, sweepDeliveredRequirements } = await import(
  './delivery-notice.js'
);

const agreed = {
  id: 'r1',
  projectId: 'p1',
  reqSeq: 3,
  title: 'Export',
  status: 'agreed',
  currentRevision: 2,
};
const move = (to: string) => ({ entity: 'issue', id: 'i1', projectId: 'p1', to }) as never;
const reset = () => {
  state.emitted = [];
  state.raised = new Set();
  state.failRead = false;
};

describe('the requirement.delivered notice', () => {
  beforeAll(() => registerRequirementDelivery());
  const handle = (to: string) =>
    consumerOf('issue.transitioned', 'requirement-delivery')?.handle(move(to), {} as never);

  it('is told when a linked issue closing leaves its agreed requirement reading delivered', async () => {
    reset();
    state.row = agreed;
    state.phase = 'delivered';
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
    reset();
    await handle('dropped');
    expect(state.emitted).toHaveLength(1);
  });

  it('is told once per revision, however many moves read it delivered', async () => {
    reset();
    await handle('closed');
    await handle('dropped');
    expect(state.emitted).toHaveLength(1);
    state.row = { ...agreed, currentRevision: 3 };
    await handle('closed');
    expect(state.emitted.map((e) => (e.payload as { revision: number }).revision)).toEqual([2, 3]);
    state.row = agreed;
  });

  it('is not told while the phase reads in_delivery, for a move that cannot complete it, or for an unlinked issue', async () => {
    reset();
    state.phase = 'in_delivery';
    await handle('closed');
    state.phase = 'delivered';
    await handle('in_progress');
    state.row = null;
    await handle('closed');
    state.row = { ...agreed, status: 'accepted' };
    await handle('closed');
    expect(state.emitted).toEqual([]);
    state.row = agreed;
  });
});

// ISS-489 r3's judge: the notice was raised only at the close, so a delivery production could not
// be read for at that moment was never told, and nothing told it after production came back
describe('the requirement-delivery sweep', () => {
  it('tells a delivery the close could not read, once a later read reads it delivered', async () => {
    reset();
    state.row = agreed;
    state.phase = 'in_delivery';
    await consumerOf('issue.transitioned', 'requirement-delivery')?.handle(
      move('closed'),
      {} as never,
    );
    expect(state.emitted).toEqual([]);

    state.candidates = [agreed];
    state.phase = 'delivered';
    expect(await sweepDeliveredRequirements()).toEqual({ read: 1, raised: 1 });
    expect(state.emitted.map((e) => e.type)).toEqual(['requirement.delivered']);
  });

  it('does not tell a revision already told', async () => {
    reset();
    state.raised.add('r1@2');
    state.candidates = [agreed];
    state.phase = 'delivered';
    expect(await sweepDeliveredRequirements()).toEqual({ read: 1, raised: 0 });
    expect(state.emitted).toEqual([]);
  });

  it('keeps reading the rest when one cannot be read, and tells nothing for it', async () => {
    reset();
    state.candidates = [agreed, { ...agreed, id: 'r2', reqSeq: 4 }];
    state.phase = 'delivered';
    state.failRead = true;
    expect(await sweepDeliveredRequirements()).toEqual({ read: 2, raised: 1 });
    expect(state.emitted.map((e) => (e.payload as { key: string }).key)).toEqual(['REQ-4']);
  });
});
