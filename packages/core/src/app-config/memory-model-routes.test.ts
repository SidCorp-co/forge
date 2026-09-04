import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';
vi.mock('../config/env.js', () => ({ env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' } }));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectLeftJoin = vi.fn(
  (): Record<string, unknown> => ({ leftJoin: selectLeftJoin, where: selectWhere }),
);
const selectFrom = vi.fn(() => ({ where: selectWhere, leftJoin: selectLeftJoin }));
const onConflict = vi.fn(() => Promise.resolve());
const insertValues = vi.fn(() => ({ onConflictDoUpdate: onConflict }));
vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
  },
}));

const reindex = {
  estimate: vi.fn(async () => ({
    memories: 3,
    totalChars: 9000,
    estimatedChunks: 9,
    estimatedEmbedCalls: 3,
    estimatedMinutes: 1,
  })),
  read: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  write: vi.fn(async (_patch: unknown) => undefined),
  enqueue: vi.fn(async () => undefined),
  purge: vi.fn(async () => undefined),
  counts: vi.fn(async () => ({ total: 3, pending: 3 })),
};
vi.mock('../memory/chunk-reindex.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../memory/chunk-reindex.js')>();
  return {
    ...actual,
    estimateReindex: () => reindex.estimate(),
    readReindex: () => reindex.read(),
    writeReindex: (_p: string, patch: unknown) => reindex.write(patch),
    enqueueChunkReindex: () => reindex.enqueue(),
    enqueueChunkPurge: () => reindex.purge(),
    countPending: () => reindex.counts(),
  };
});

const { memoryModelRoutes } = await import('./memory-model-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';

function app() {
  const a = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  a.use('*', requestId());
  a.route('/api/app-config', memoryModelRoutes);
  a.onError(errorHandler);
  return a;
}
const authVerified = () => selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
const asAdmin = () =>
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'admin', orgRole: null }]);
const asMember = () =>
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);

async function call(method: string, path: string, body?: unknown) {
  return app().request(`/api/app-config/${PROJECT_ID}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${await signUserToken(USER_ID)}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  reindex.read.mockResolvedValue(null);
});

describe('GET estimate and reindex', () => {
  it('a member reads the estimate the chunk-reindex module computes', async () => {
    authVerified();
    asMember();
    const res = await call('GET', '/memory-model/estimate');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ memories: 3, estimatedChunks: 9 });
  });
  it('a member reads the model and the reindex state', async () => {
    authVerified();
    asMember();
    selectLimit.mockResolvedValueOnce([{ model: 'chunked' }]);
    reindex.read.mockResolvedValueOnce({ state: 'running', total: 3, done: 1, remaining: 2 });
    const res = await call('GET', '/memory-model/reindex');
    expect(await res.json()).toEqual({
      model: 'chunked',
      reindex: { state: 'running', total: 3, done: 1, remaining: 2 },
    });
  });
});

describe('POST memory-model', () => {
  it('a member is refused with 403 before any write', async () => {
    authVerified();
    asMember();
    expect((await call('POST', '/memory-model', { model: 'chunked' })).status).toBe(403);
    expect(insertValues).not.toHaveBeenCalled();
    expect(reindex.enqueue).not.toHaveBeenCalled();
  });
  it('an admin flipping to chunked gets 202, a queued state sized by the pending count, and one enqueued job', async () => {
    authVerified();
    asAdmin();
    const res = await call('POST', '/memory-model', { model: 'chunked' });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { model: string; reindex: Record<string, unknown> };
    expect(body.model).toBe('chunked');
    expect(body.reindex).toMatchObject({ state: 'queued', total: 3, done: 0, remaining: 3 });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, memoryModel: 'chunked' }),
    );
    expect(reindex.enqueue).toHaveBeenCalledOnce();
  });
  it('409 while a reindex is queued or running, and nothing is written', async () => {
    authVerified();
    asAdmin();
    reindex.read.mockResolvedValueOnce({ state: 'running', total: 3, done: 1, remaining: 2 });
    expect((await call('POST', '/memory-model', { model: 'chunked' })).status).toBe(409);
    expect(insertValues).not.toHaveBeenCalled();
    expect(reindex.enqueue).not.toHaveBeenCalled();
  });
  it('flipping to flat writes flat at once, cancels a live reindex and schedules the purge', async () => {
    authVerified();
    asAdmin();
    reindex.read
      .mockResolvedValueOnce({ state: 'running', total: 3, done: 1, remaining: 2 })
      .mockResolvedValueOnce({ state: 'cancelled', total: 3, done: 1, remaining: 2 });
    const res = await call('POST', '/memory-model', { model: 'flat' });
    expect(res.status).toBe(200);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, memoryModel: 'flat' }),
    );
    expect(reindex.write).toHaveBeenCalledWith(expect.objectContaining({ state: 'cancelled' }));
    expect(reindex.purge).toHaveBeenCalledOnce();
    expect(await res.json()).toMatchObject({ model: 'flat', reindex: { state: 'cancelled' } });
  });
  it('a model outside flat|chunked is 400', async () => {
    authVerified();
    asAdmin();
    expect((await call('POST', '/memory-model', { model: 'sharded' })).status).toBe(400);
  });
});

describe('DELETE reindex', () => {
  it('cancels a live reindex', async () => {
    authVerified();
    asAdmin();
    reindex.read
      .mockResolvedValueOnce({ state: 'queued', total: 3, done: 0, remaining: 3 })
      .mockResolvedValueOnce({ state: 'cancelled', total: 3, done: 0, remaining: 3 });
    const res = await call('DELETE', '/memory-model/reindex');
    expect(res.status).toBe(200);
    expect(reindex.write).toHaveBeenCalledWith(expect.objectContaining({ state: 'cancelled' }));
  });
  it('409 when nothing is live', async () => {
    authVerified();
    asAdmin();
    reindex.read.mockResolvedValueOnce({ state: 'completed', total: 3, done: 3, remaining: 0 });
    expect((await call('DELETE', '/memory-model/reindex')).status).toBe(409);
    expect(reindex.write).not.toHaveBeenCalled();
  });
});
