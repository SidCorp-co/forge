import { beforeEach, describe, expect, it, vi } from 'vitest';

const offset = vi.fn();
const limit = vi.fn(() => ({ offset }));
const orderBy = vi.fn(() => ({ limit }));
const where = vi.fn(() => ({ orderBy, limit }));
const from = vi.fn(() => ({ where }));
const select = vi.fn(() => ({ from }));

vi.mock('../db/client.js', () => ({
  db: { select },
}));

const { getMemoryInputSchema, runMemoryGet } = await import('./get-service.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  offset.mockReset();
  limit.mockClear();
  orderBy.mockClear();
  where.mockClear();
  from.mockClear();
  select.mockClear();
});

describe('getMemoryInputSchema', () => {
  it('accepts a minimal payload and fills defaults', () => {
    const r = getMemoryInputSchema.safeParse({ projectId: PROJECT_ID });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(50);
      expect(r.data.offset).toBe(0);
      expect(r.data.orderBy).toBe('createdAt');
      expect(r.data.orderDir).toBe('desc');
    }
  });

  it('accepts a fully-specified payload including metadataFilter', () => {
    const r = getMemoryInputSchema.safeParse({
      projectId: PROJECT_ID,
      source: 'step_handoff',
      sourceRef: 'run:1/step:plan/attempt:1',
      metadataFilter: { run_id: 'r-1', step: 'plan', attempt: 1, finalized: true },
      limit: 10,
      offset: 5,
      orderBy: 'updatedAt',
      orderDir: 'asc',
    });
    expect(r.success).toBe(true);
  });

  it('rejects orderBy outside the allow-list', () => {
    const r = getMemoryInputSchema.safeParse({ projectId: PROJECT_ID, orderBy: 'random' });
    expect(r.success).toBe(false);
  });

  it('rejects limit above 200 (caps via z.number().max)', () => {
    const r = getMemoryInputSchema.safeParse({ projectId: PROJECT_ID, limit: 999 });
    expect(r.success).toBe(false);
  });

  it('rejects metadataFilter with object values (only scalar)', () => {
    const r = getMemoryInputSchema.safeParse({
      projectId: PROJECT_ID,
      metadataFilter: { nested: { a: 1 } },
    });
    expect(r.success).toBe(false);
  });
});

describe('runMemoryGet', () => {
  it('queries count + rows with applied filters', async () => {
    // 1st select: count → returns [{n: 3}]
    // 2nd select: rows → returns 3 rows
    const fakeRows = [
      { id: 'm-1', projectId: PROJECT_ID, source: 'step_handoff', sourceRef: 'r-1',
        textContent: 't', metadata: {}, embeddedAt: new Date(), createdAt: new Date(),
        updatedAt: new Date() },
    ];
    // count query: select().from().where() → returns array directly
    // rows query: select().from().where().orderBy().limit().offset() → returns array
    where
      .mockReturnValueOnce(Promise.resolve([{ n: 3 }]) as never) // count terminates at .where()
      .mockReturnValueOnce({ orderBy, limit } as never);          // rows continues chain
    offset.mockResolvedValueOnce(fakeRows);

    const r = await runMemoryGet({
      projectId: PROJECT_ID,
      source: 'step_handoff',
      metadataFilter: { run_id: 'r-1' },
      limit: 50,
      offset: 0,
      orderBy: 'createdAt',
      orderDir: 'desc',
    });

    expect(r.total).toBe(3);
    expect(r.rows).toEqual(fakeRows);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('passes single-condition where when no filters beyond projectId', async () => {
    where
      .mockReturnValueOnce(Promise.resolve([{ n: 0 }]) as never)
      .mockReturnValueOnce({ orderBy, limit } as never);
    offset.mockResolvedValueOnce([]);

    const r = await runMemoryGet({
      projectId: PROJECT_ID,
      limit: 50,
      offset: 0,
      orderBy: 'createdAt',
      orderDir: 'desc',
    });

    expect(r.total).toBe(0);
    expect(r.rows).toEqual([]);
  });
});
