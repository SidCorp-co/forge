import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const selectColumns = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn((columns: unknown) => {
      selectColumns(columns);
      return { from: selectFrom };
    }),
  },
}));

const verifyDeviceCredentialMock = vi.fn();
vi.mock('../auth/device-credential.js', () => ({
  verifyDeviceCredential: (token: string) => verifyDeviceCredentialMock(token),
}));

const { requireAuth, requireUserOrDevice, assertEmailVerified } = await import('./auth.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('./error.js');
const { requestId } = await import('./request-id.js');

type Vars = import('./request-id.js').RequestIdVars & import('./auth.js').AuthVars;

function codeOf(err: unknown): string {
  const cause = (err as { cause?: { code?: string } }).cause;
  return cause?.code ?? 'NO_CODE';
}

const VERIFIED = { email: 'ok@example.com', emailVerifiedAt: new Date('2026-01-01T00:00:00Z') };

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
  selectColumns.mockReset();
  verifyDeviceCredentialMock.mockReset();
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
  // cm:guard mounted TWICE on one path, the way a request that crosses two routers sees it: measured 2026-09-15, `GET /api/projects/:id/issues` read `email_verified_at` eight times, and this is the assertion that keeps it at one (ISS-1009).
  it('reads the row once however many mounts a request crosses', async () => {
    const token = await signUserToken('uuid-ok');
    selectLimit.mockResolvedValueOnce([VERIFIED]);
    const app = new Hono<{ Variables: Vars }>();
    app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
    app.use('*', requestId());
    app.use('*', requireAuth(), assertEmailVerified());
    app.use('/twice', requireAuth(), assertEmailVerified());
    app.get('/twice', (c) => c.json({ ok: true }));
    const before = selectLimit.mock.calls.length;
    const res = await app.request('/twice', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(selectLimit.mock.calls.length - before).toBe(1);
  });

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

  // cm:guard the row and never the verdict: these two assertions are what stop the memo becoming a `verified` flag again, which would let the second mount through on a row the first refused (ISS-1009, ISS-1012).
  it('refuses EMAIL_NOT_VERIFIED on every invocation, not only the first', async () => {
    const token = await signUserToken('uuid-unverified');
    selectLimit.mockResolvedValueOnce([{ email: 'no@example.com', emailVerifiedAt: null }]);
    const gate = assertEmailVerified();
    const seen: string[] = [];

    const app = new Hono<{ Variables: import('./auth.js').AuthVars }>();
    app.get('/twice', requireAuth(), async (c) => {
      for (let i = 0; i < 2; i += 1) {
        try {
          await gate(c, async () => {
            seen.push('through');
          });
        } catch (err) {
          seen.push(codeOf(err));
        }
      }
      return c.json({ seen, reads: selectLimit.mock.calls.length });
    });

    const res = await app.request('/twice', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      seen: ['EMAIL_NOT_VERIFIED', 'EMAIL_NOT_VERIFIED'],
      reads: 1,
    });
  });

  it('re-reads when the authenticated userId changes on one request context', async () => {
    const token = await signUserToken('uuid-a');
    selectLimit
      .mockResolvedValueOnce([VERIFIED])
      .mockResolvedValueOnce([{ email: 'b@example.com', emailVerifiedAt: null }]);
    const gate = assertEmailVerified();
    const seen: string[] = [];

    const app = new Hono<{ Variables: import('./auth.js').AuthVars }>();
    app.get('/switch', requireAuth(), async (c) => {
      await gate(c, async () => {
        seen.push('A:through');
      });
      c.set('userId', 'uuid-b');
      try {
        await gate(c, async () => {
          seen.push('B:through');
        });
      } catch (err) {
        seen.push(`B:${codeOf(err)}`);
      }
      return c.json({ seen, reads: selectLimit.mock.calls.length });
    });

    const res = await app.request('/switch', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      seen: ['A:through', 'B:EMAIL_NOT_VERIFIED'],
      reads: 2,
    });
  });

  it('selects email alongside email_verified_at, so one row answers both gates', async () => {
    const token = await signUserToken('uuid-ok');
    selectLimit.mockResolvedValueOnce([VERIFIED]);

    const res = await buildApp().request('/verified', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(Object.keys(selectColumns.mock.calls[0]?.[0] as object).sort()).toEqual([
      'email',
      'emailVerifiedAt',
    ]);
  });

  it('does not outlive its request — the next request reads the row again', async () => {
    const token = await signUserToken('uuid-ok');
    selectLimit.mockResolvedValue([VERIFIED]);
    const app = buildApp();

    expect(
      (await app.request('/verified', { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(200);
    expect(
      (await app.request('/verified', { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(200);
    expect(selectLimit.mock.calls.length).toBe(2);
  });

  // cm:guard the device token stands in for the mailbox, so this branch must read no row at all — a device has no `userId`, and a lookup here would refuse every paired box as unverified.
  it('lets a device principal through without reading users', async () => {
    verifyDeviceCredentialMock.mockResolvedValueOnce({ id: 'dev-1' });

    const app = new Hono<{ Variables: Vars }>();
    app.use('*', requestId());
    app.get('/device', requireUserOrDevice(), assertEmailVerified(), (c) =>
      c.json({ principal: c.get('principal'), reads: selectLimit.mock.calls.length }),
    );
    app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);

    const res = await app.request('/device', {
      headers: { authorization: `Bearer forge_pat_dev_${'a'.repeat(64)}` },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ principal: 'device', reads: 0 });
  });
});
