/**
 * ISS-1012 — the platform-admin gate decides on the row the email gate already
 * read, and re-derives its own refusal every time it runs.
 *
 * `isPlatformAdmin` is the sibling with no request to memoise against: the WS
 * `canSubscribe` gate holds a socket, not a `c`, so its read is proved here to
 * stay a read.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';
const ADMIN_EMAIL = 'ops@example.com';

const testEnv: { JWT_SECRET: string; NODE_ENV: string; ADMIN_EMAILS?: string | undefined } = {
  JWT_SECRET: TEST_SECRET,
  NODE_ENV: 'test',
};
vi.mock('../config/env.js', () => ({ env: testEnv }));

const selectLimit = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) }),
  },
}));

const { requireAuth, assertEmailVerified } = await import('./auth.js');
const { assertPlatformAdmin, isPlatformAdmin, requireAdmin } = await import('./require-admin.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('./error.js');
const { requestId } = await import('./request-id.js');

type Vars = import('./request-id.js').RequestIdVars & import('./auth.js').AuthVars;

function codeOf(err: unknown): string {
  const cause = (err as { cause?: { code?: string } }).cause;
  return cause?.code ?? 'NO_CODE';
}

function app(): Hono<{ Variables: Vars }> {
  const a = new Hono<{ Variables: Vars }>();
  a.use('*', requestId());
  a.onError(errorHandler as unknown as Parameters<typeof a.onError>[0]);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  testEnv.ADMIN_EMAILS = ADMIN_EMAIL;
});

describe('requireAdmin', () => {
  it('reads users once for the email gate and the admin gate together', async () => {
    const token = await signUserToken('uuid-admin');
    selectLimit.mockResolvedValueOnce([{ email: ADMIN_EMAIL, emailVerifiedAt: new Date() }]);

    const a = app();
    a.use('*', requireAuth(), assertEmailVerified(), requireAdmin());
    a.use('/second', requireAuth(), assertEmailVerified(), requireAdmin());
    a.get('/second', (c) => c.json({ reads: selectLimit.mock.calls.length }));

    const res = await a.request('/second', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ reads: 1 });
  });

  it('matches the allow-list address case-insensitively', async () => {
    const token = await signUserToken('uuid-admin');
    selectLimit.mockResolvedValueOnce([
      { email: ADMIN_EMAIL.toUpperCase(), emailVerifiedAt: new Date() },
    ]);

    const a = app();
    a.get('/x', requireAuth(), requireAdmin(), (c) => c.json({ ok: true }));

    expect((await a.request('/x', { headers: { authorization: `Bearer ${token}` } })).status).toBe(
      200,
    );
  });

  it('401 UNAUTHENTICATED when the userId resolves to no users row', async () => {
    const token = await signUserToken('uuid-ghost');
    selectLimit.mockResolvedValueOnce([]);

    const a = app();
    a.get('/x', requireAuth(), requireAdmin(), (c) => c.json({ ok: true }));

    const res = await a.request('/x', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('403 ADMIN_ONLY when ADMIN_EMAILS is unset, so an empty list admits nobody', async () => {
    testEnv.ADMIN_EMAILS = undefined;
    const token = await signUserToken('uuid-user');
    selectLimit.mockResolvedValueOnce([{ email: ADMIN_EMAIL, emailVerifiedAt: new Date() }]);

    const a = app();
    a.get('/x', requireAuth(), requireAdmin(), (c) => c.json({ ok: true }));

    const res = await a.request('/x', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: 'ADMIN_ONLY' });
  });

  it('refuses ADMIN_ONLY on every invocation, having read the row once', async () => {
    const token = await signUserToken('uuid-outsider');
    selectLimit.mockResolvedValueOnce([
      { email: 'outsider@example.com', emailVerifiedAt: new Date() },
    ]);
    const seen: string[] = [];

    const a = new Hono<{ Variables: import('./auth.js').AuthVars }>();
    a.get('/twice', requireAuth(), async (c) => {
      for (let i = 0; i < 2; i += 1) {
        try {
          await assertPlatformAdmin(c);
          seen.push('through');
        } catch (err) {
          seen.push(codeOf(err));
        }
      }
      return c.json({ seen, reads: selectLimit.mock.calls.length });
    });

    const res = await a.request('/twice', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      seen: ['ADMIN_ONLY', 'ADMIN_ONLY'],
      reads: 1,
    });
  });
});

describe('isPlatformAdmin — no Hono context', () => {
  it('answers true for a user whose email is on the allow-list', async () => {
    selectLimit.mockResolvedValueOnce([{ email: ADMIN_EMAIL, emailVerifiedAt: new Date() }]);
    await expect(isPlatformAdmin('uuid-admin')).resolves.toBe(true);
  });

  it('answers false for a user whose email is not on the allow-list', async () => {
    selectLimit.mockResolvedValueOnce([
      { email: 'outsider@example.com', emailVerifiedAt: new Date() },
    ]);
    await expect(isPlatformAdmin('uuid-outsider')).resolves.toBe(false);
  });

  it('answers false for a userId that resolves to no users row', async () => {
    selectLimit.mockResolvedValueOnce([]);
    await expect(isPlatformAdmin('uuid-ghost')).resolves.toBe(false);
  });

  it('reads the database on every call, having no request to memoise against', async () => {
    selectLimit.mockResolvedValue([{ email: ADMIN_EMAIL, emailVerifiedAt: new Date() }]);
    await isPlatformAdmin('uuid-admin');
    await isPlatformAdmin('uuid-admin');
    expect(selectLimit.mock.calls.length).toBe(2);
  });
});
