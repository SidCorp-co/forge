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

const { requireAuth, assertEmailVerified } = await import('./auth.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('./error.js');
const { requestId } = await import('./request-id.js');

type Vars = import('./request-id.js').RequestIdVars & { userId: string };

function buildApp() {
  const app = new Hono<{ Variables: Vars }>();
  app.use('*', requestId());
  app.get('/protected', requireAuth(), (c) => c.json({ userId: c.get('userId') }));
  app.get('/verified', requireAuth(), assertEmailVerified(), (c) =>
    c.json({ ok: true, userId: c.get('userId') }),
  );
  app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
});

describe('requireAuth', () => {
  it('401 UNAUTHENTICATED when no token is present', async () => {
    const res = await buildApp().request('/protected');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHENTICATED');
  });

  it('401 INVALID_TOKEN when Bearer token is invalid', async () => {
    const res = await buildApp().request('/protected', {
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_TOKEN');
  });

  it('sets userId and calls next() on valid Bearer token', async () => {
    const token = await signUserToken('uuid-1');
    const res = await buildApp().request('/protected', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ userId: 'uuid-1' });
  });

  it('falls back to forge_auth cookie when no Authorization header', async () => {
    const token = await signUserToken('uuid-cookie');
    const res = await buildApp().request('/protected', {
      headers: { cookie: `forge_auth=${token}` },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ userId: 'uuid-cookie' });
  });
});

describe('assertEmailVerified', () => {
  it('403 EMAIL_NOT_VERIFIED when emailVerifiedAt is null', async () => {
    const token = await signUserToken('uuid-unverified');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: null }]);

    const res = await buildApp().request('/verified', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('EMAIL_NOT_VERIFIED');
    expect(body.message).toBe('verify email');
  });

  it('403 EMAIL_NOT_VERIFIED when user row is missing', async () => {
    const token = await signUserToken('uuid-ghost');
    selectLimit.mockResolvedValueOnce([]);

    const res = await buildApp().request('/verified', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('passes through when emailVerifiedAt is set', async () => {
    const token = await signUserToken('uuid-ok');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date('2026-01-01T00:00:00Z') }]);

    const res = await buildApp().request('/verified', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, userId: 'uuid-ok' });
  });
});
