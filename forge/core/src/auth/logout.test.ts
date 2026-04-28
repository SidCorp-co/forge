import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const updateWhere = vi.fn(async () => undefined);
const updateSet = vi.fn(() => ({ where: updateWhere }));
const updateMock = vi.fn(() => ({ set: updateSet }));

vi.mock('../db/client.js', () => ({
  db: { update: updateMock },
}));

const { logoutRoutes } = await import('./logout.js');
const { AUTH_COOKIE_NAME } = await import('./cookie.js');
const { signUserToken } = await import('./jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/auth', logoutRoutes);
  app.onError(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/auth/logout', () => {
  it('returns 401 without a token', async () => {
    const res = await buildApp().request('/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('clears the auth cookie and returns 204', async () => {
    const token = await signUserToken('00000000-0000-0000-0000-000000000001');
    const res = await buildApp().request('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(204);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(AUTH_COOKIE_NAME);
    // hono/cookie deleteCookie emits Max-Age=0 (and/or Expires in the past).
    expect(setCookie).toMatch(/Max-Age=0|Expires=/i);
  });

  it('marks all active refresh tokens used so they cannot rotate', async () => {
    const userId = '00000000-0000-0000-0000-000000000002';
    const token = await signUserToken(userId);
    const res = await buildApp().request('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(204);
    // The handler should have invoked db.update(refreshTokens).set({usedAt:…})
    // exactly once for this user. We don't assert the WHERE clause shape (Drizzle
    // builds an opaque object); the trip through updateMock is enough proof.
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });
});
