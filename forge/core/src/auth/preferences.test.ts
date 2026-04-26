import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const whereResults: unknown[][] = [];
const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({
  limit: selectLimit,
  then: (cb: (v: unknown) => unknown) => {
    const result = whereResults.shift() ?? [];
    return Promise.resolve(result).then(cb);
  },
}));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const insertReturning = vi.fn();
const onConflictDoUpdate = vi.fn(() => ({ returning: insertReturning }));
const insertValues = vi.fn(() => ({ onConflictDoUpdate }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
  },
}));

const { preferenceRoutes } = await import('./preferences.js');
const { signUserToken } = await import('./jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');
const hooksModule = await import('../pipeline/hooks.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/auth', preferenceRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  insertReturning.mockReset();
  whereResults.length = 0;
  hooksModule.hooks.reset();
});

async function token() {
  return signUserToken(USER_ID);
}

describe('GET /api/auth/preferences', () => {
  it('401 without token', async () => {
    const res = await buildApp().request('/api/auth/preferences');
    expect(res.status).toBe(401);
  });

  it('returns defaults when no row exists (never 404)', async () => {
    selectLimit.mockResolvedValueOnce([]);
    const res = await buildApp().request('/api/auth/preferences', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: USER_ID,
      theme: 'system',
      language: 'en',
      updatedAt: null,
    });
  });

  it('returns the persisted row when present', async () => {
    const updatedAt = new Date('2026-04-26T00:00:00.000Z').toISOString();
    selectLimit.mockResolvedValueOnce([
      { userId: USER_ID, theme: 'dark', language: 'vi', updatedAt },
    ]);
    const res = await buildApp().request('/api/auth/preferences', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: USER_ID,
      theme: 'dark',
      language: 'vi',
      updatedAt,
    });
  });
});

describe('PATCH /api/auth/preferences', () => {
  it('rejects empty body', async () => {
    const res = await buildApp().request('/api/auth/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('rejects unknown theme', async () => {
    const res = await buildApp().request('/api/auth/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ theme: 'pink' }),
    });
    expect(res.status).toBe(400);
  });

  it('upserts and emits userPreferencesChanged hook', async () => {
    insertReturning.mockResolvedValueOnce([
      {
        userId: USER_ID,
        theme: 'dark',
        language: 'en',
        updatedAt: new Date().toISOString(),
      },
    ]);
    const seen: Array<{ userId: string; theme: string; language: string }> = [];
    hooksModule.hooks.on('userPreferencesChanged', (p) => {
      seen.push({ userId: p.userId, theme: p.theme, language: p.language });
    });

    const res = await buildApp().request('/api/auth/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ theme: 'dark' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { theme: string };
    expect(body.theme).toBe('dark');
    expect(seen).toEqual([{ userId: USER_ID, theme: 'dark', language: 'en' }]);
  });
});
