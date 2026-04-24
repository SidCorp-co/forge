import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
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
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    const res = await buildApp().request('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(userId);
    expect(body.email).toBe('u@example.com');
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
