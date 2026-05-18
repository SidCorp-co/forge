import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
// /me selects users (.limit()) AND oauth_accounts (no .limit()) — so .where()
// itself must be awaitable. Tests that don't care about the oauth read get an
// empty array by default; tests that do can override via .mockResolvedValueOnce.
const oauthWhereResult = vi.fn().mockResolvedValue([]);
function whereChain() {
  const promise: PromiseLike<unknown> = {
    then(onFulfilled, onRejected) {
      return oauthWhereResult().then(onFulfilled, onRejected);
    },
  };
  return Object.assign(promise, { limit: selectLimit });
}
const selectWhere = vi.fn(() => whereChain());
const selectFrom = vi.fn(() => ({ where: selectWhere }));

const insertReturning = vi.fn();
const onConflictDoUpdate = vi.fn(() => ({ returning: insertReturning }));
const insertValues = vi.fn(() => ({ onConflictDoUpdate }));
const dbInsert = vi.fn(() => ({ values: insertValues }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: dbInsert,
  },
}));

const { meRoutes } = await import('./me.js');
const { signUserToken } = await import('./jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/auth', meRoutes);
  app.onError(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  insertReturning.mockReset();
  oauthWhereResult.mockReset();
  oauthWhereResult.mockResolvedValue([]);
});

describe('GET /api/auth/me', () => {
  it('returns 401 without a token', async () => {
    const res = await buildApp().request('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns user row for a valid token', async () => {
    const userId = '00000000-0000-0000-0000-000000000001';
    const token = await signUserToken(userId);
    selectLimit.mockResolvedValueOnce([
      {
        id: userId,
        email: 'u@example.com',
        emailVerifiedAt: null,
        isCeo: false,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        passwordHash: '$argon2id$hash',
      },
    ]);

    const res = await buildApp().request('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(userId);
    expect(body.email).toBe('u@example.com');
    expect(body.hasPassword).toBe(true);
    expect(body.oauthProviders).toEqual([]);
    expect(body.passwordHash).toBeUndefined();
  });

  it('flags SSO-only users with hasPassword=false + linked oauthProviders', async () => {
    const userId = '00000000-0000-0000-0000-000000000044';
    const token = await signUserToken(userId);
    selectLimit.mockResolvedValueOnce([
      {
        id: userId,
        email: 'sso@example.com',
        emailVerifiedAt: new Date('2026-04-01T00:00:00Z'),
        isCeo: false,
        createdAt: new Date('2026-04-01T00:00:00Z'),
        passwordHash: null,
      },
    ]);
    oauthWhereResult.mockResolvedValueOnce([
      { provider: 'google' },
      { provider: 'google' },
      { provider: 'github' },
    ]);

    const res = await buildApp().request('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasPassword).toBe(false);
    expect(body.oauthProviders.sort()).toEqual(['github', 'google']);
  });

  it('returns 401 when the token resolves to no user', async () => {
    const token = await signUserToken('00000000-0000-0000-0000-000000000002');
    selectLimit.mockResolvedValueOnce([]);

    const res = await buildApp().request('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/me/preferences', () => {
  it('returns defaults when the user has no row', async () => {
    const token = await signUserToken('00000000-0000-0000-0000-000000000003');
    selectLimit.mockResolvedValueOnce([]);
    const res = await buildApp().request('/api/auth/me/preferences', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ theme: 'system', language: 'en', updatedAt: null });
  });

  it('returns the stored row when present', async () => {
    const token = await signUserToken('00000000-0000-0000-0000-000000000003');
    selectLimit.mockResolvedValueOnce([
      { theme: 'dark', language: 'vi', updatedAt: new Date('2026-04-27T00:00:00Z') },
    ]);
    const res = await buildApp().request('/api/auth/me/preferences', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.theme).toBe('dark');
    expect(body.language).toBe('vi');
  });

  it('rejects without a token', async () => {
    const res = await buildApp().request('/api/auth/me/preferences');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/auth/me/preferences', () => {
  it('upserts and echoes the new row', async () => {
    const token = await signUserToken('00000000-0000-0000-0000-000000000003');
    insertReturning.mockResolvedValueOnce([
      { theme: 'dark', language: 'en', updatedAt: new Date('2026-04-27T00:00:00Z') },
    ]);
    const res = await buildApp().request('/api/auth/me/preferences', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'dark' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.theme).toBe('dark');
    expect(dbInsert).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty body', async () => {
    const token = await signUserToken('00000000-0000-0000-0000-000000000003');
    const res = await buildApp().request('/api/auth/me/preferences', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('rejects unknown theme value', async () => {
    const token = await signUserToken('00000000-0000-0000-0000-000000000003');
    const res = await buildApp().request('/api/auth/me/preferences', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'rainbow' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects unknown extra fields (strict)', async () => {
    const token = await signUserToken('00000000-0000-0000-0000-000000000003');
    const res = await buildApp().request('/api/auth/me/preferences', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'dark', secret: 'haha' }),
    });
    expect(res.status).toBe(400);
  });
});
