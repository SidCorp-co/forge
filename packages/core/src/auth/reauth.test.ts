import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const updateWhere = vi.fn(async () => undefined);
const updateSet = vi.fn(() => ({ where: updateWhere }));
const updateFn = vi.fn(() => ({ set: updateSet }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    update: updateFn,
  },
}));

vi.mock('./password.js', () => ({
  verifyPassword: vi.fn(),
  getDummyPasswordHash: vi.fn(async () => 'dummy-hash'),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: () => async (c: import('hono').Context, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    await next();
  },
}));

const { reauthRoutes } = await import('./reauth.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');
const { __resetRateLimitStore } = await import('../middleware/rate-limit.js');
const { verifyPassword } = await import('./password.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/auth', reauthRoutes);
  app.onError(errorHandler);
  return app;
}

function post(body: unknown, ip = '10.0.0.1') {
  return buildApp().request('/api/auth/reauth', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  updateWhere.mockClear();
  updateSet.mockClear();
  updateFn.mockClear();
  __resetRateLimitStore();
});

describe('POST /api/auth/reauth', () => {
  it('returns 200 + freshAuthAt and stamps the row on correct password', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'user-1', passwordHash: 'hashed' }]);
    vi.mocked(verifyPassword).mockResolvedValueOnce(true);

    const res = await post({ password: 'correct' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { freshAuthAt: string };
    expect(typeof body.freshAuthAt).toBe('string');
    expect(Number.isNaN(Date.parse(body.freshAuthAt))).toBe(false);
    expect(updateFn).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledTimes(1);
    const setArg = updateSet.mock.calls[0]?.[0] as { lastFreshAuthAt: Date };
    expect(setArg.lastFreshAuthAt).toBeInstanceOf(Date);
  });

  it('returns 401 INVALID_CREDENTIALS on wrong password; does NOT stamp', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'user-1', passwordHash: 'hashed' }]);
    vi.mocked(verifyPassword).mockResolvedValueOnce(false);

    const res = await post({ password: 'wrong' }, '10.0.0.2');

    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_CREDENTIALS');
    expect(updateFn).not.toHaveBeenCalled();
  });

  it('returns 401 for OAuth-only users (passwordHash null), runs dummy verify', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'user-1', passwordHash: null }]);
    vi.mocked(verifyPassword).mockResolvedValueOnce(false);

    const res = await post({ password: 'anything' }, '10.0.0.3');

    expect(res.status).toBe(401);
    expect(verifyPassword).toHaveBeenCalledWith('anything', 'dummy-hash');
    expect(updateFn).not.toHaveBeenCalled();
  });

  it('returns 400 BAD_REQUEST on empty body', async () => {
    const res = await post({}, '10.0.0.4');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('BAD_REQUEST');
  });
});
