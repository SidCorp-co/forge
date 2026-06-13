import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
  },
}));

const { requireFreshAuth } = await import('./require-fresh-auth.js');
const { errorHandler } = await import('./error.js');
const { requestId } = await import('./request-id.js');

function buildApp(minutes?: number) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use('*', requestId());
  app.use('/gated', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.use('/gated', requireFreshAuth(minutes));
  app.get('/gated', (c) => c.json({ ok: true }));
  app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
  return app;
}

function get(minutes?: number) {
  return buildApp(minutes).request('/gated', { method: 'GET' });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
});

describe('requireFreshAuth()', () => {
  it('returns 403 FRESH_AUTH_REQUIRED when the user row is missing', async () => {
    selectLimit.mockResolvedValueOnce([]);
    const res = await get();
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('FRESH_AUTH_REQUIRED');
  });

  it('returns 403 when the stamp is null (never re-authed)', async () => {
    selectLimit.mockResolvedValueOnce([{ lastFreshAuthAt: null }]);
    const res = await get();
    expect(res.status).toBe(403);
  });

  it('returns 403 when the stamp is older than the window', async () => {
    const stale = new Date(Date.now() - 10 * 60_000);
    selectLimit.mockResolvedValueOnce([{ lastFreshAuthAt: stale }]);
    const res = await get(5);
    expect(res.status).toBe(403);
  });

  it('passes through when the stamp is fresh', async () => {
    const fresh = new Date(Date.now() - 60_000);
    selectLimit.mockResolvedValueOnce([{ lastFreshAuthAt: fresh }]);
    const res = await get(5);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('defaults to a 5-minute window', async () => {
    const stale = new Date(Date.now() - 6 * 60_000);
    selectLimit.mockResolvedValueOnce([{ lastFreshAuthAt: stale }]);
    const res = await get();
    expect(res.status).toBe(403);
  });
});
