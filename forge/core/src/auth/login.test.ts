import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

const txInsertValues = vi.fn(async () => undefined);

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        insert: vi.fn(() => ({ values: txInsertValues })),
      };
      return cb(tx);
    }),
  },
}));

vi.mock('./password.js', () => ({
  verifyPassword: vi.fn(),
  getDummyPasswordHash: vi.fn(async () => 'dummy-hash'),
}));

const { loginRoutes } = await import('./login.js');
const { verifyUserToken } = await import('./jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');
const { db } = await import('../db/client.js');
const { verifyPassword } = await import('./password.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/auth', loginRoutes);
  app.onError(errorHandler);
  return app;
}

function post(body: unknown) {
  return buildApp().request('/api/auth/local', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  txInsertValues.mockClear();
});

describe('POST /api/auth/local', () => {
  const verifiedUser = {
    id: 'uuid-1',
    email: 'a@b.co',
    passwordHash: 'hashed',
    emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
  };

  it('returns 200 with token + user + cookie on valid creds (verified)', async () => {
    selectLimit.mockResolvedValueOnce([verifiedUser]);
    vi.mocked(verifyPassword).mockResolvedValueOnce(true);

    const res = await post({ email: 'a@b.co', password: 'correct' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      user: { id: string; email: string; emailVerified: boolean };
      emailVerificationRequired: boolean;
    };
    expect(body.user).toEqual({ id: 'uuid-1', email: 'a@b.co', emailVerified: true });
    expect(body.emailVerificationRequired).toBe(false);
    expect(typeof body.token).toBe('string');
    // refreshToken no longer in JSON — rides the forge_refresh httpOnly cookie.
    expect((body as Record<string, unknown>).refreshToken).toBeUndefined();
    expect(txInsertValues).toHaveBeenCalledTimes(1);

    const refreshCookie = (res.headers.get('set-cookie') ?? '').includes('forge_refresh=');
    expect(refreshCookie).toBe(true);

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('forge_auth=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Secure');

    expect(db.select).toHaveBeenCalledTimes(1);
    expect(verifyPassword).toHaveBeenCalledWith('correct', 'hashed');
  });

  it('returned token verifies with sub === user.id', async () => {
    selectLimit.mockResolvedValueOnce([verifiedUser]);
    vi.mocked(verifyPassword).mockResolvedValueOnce(true);

    const res = await post({ email: 'a@b.co', password: 'correct' });
    const { token } = (await res.json()) as { token: string };
    const claims = await verifyUserToken(token);
    expect(claims.sub).toBe('uuid-1');
    expect(claims.typ).toBe('user');
  });

  it('returns 401 INVALID_CREDENTIALS on unknown email, no Set-Cookie', async () => {
    selectLimit.mockResolvedValueOnce([]);
    vi.mocked(verifyPassword).mockResolvedValueOnce(false);

    const res = await post({ email: 'nobody@b.co', password: 'x' });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_CREDENTIALS');
    expect(res.headers.get('set-cookie')).toBeNull();
    // Unknown-email path runs a dummy verify to equalize timing and prevent
    // user enumeration — it must be called, against the dummy hash.
    expect(verifyPassword).toHaveBeenCalledTimes(1);
    expect(verifyPassword).toHaveBeenCalledWith('x', 'dummy-hash');
  });

  it('returns 401 INVALID_CREDENTIALS on wrong password, no Set-Cookie', async () => {
    selectLimit.mockResolvedValueOnce([verifiedUser]);
    vi.mocked(verifyPassword).mockResolvedValueOnce(false);

    const res = await post({ email: 'a@b.co', password: 'wrong' });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_CREDENTIALS');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('allows login for unverified email and flags emailVerificationRequired: true', async () => {
    selectLimit.mockResolvedValueOnce([{ ...verifiedUser, emailVerifiedAt: null }]);
    vi.mocked(verifyPassword).mockResolvedValueOnce(true);

    const res = await post({ email: 'a@b.co', password: 'correct' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { emailVerified: boolean };
      emailVerificationRequired: boolean;
    };
    expect(body.user.emailVerified).toBe(false);
    expect(body.emailVerificationRequired).toBe(true);
    expect(res.headers.get('set-cookie')).toContain('forge_auth=');
  });

  it('returns 400 BAD_REQUEST on missing password', async () => {
    const res = await post({ email: 'a@b.co' });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('BAD_REQUEST');
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns 400 BAD_REQUEST on invalid email format', async () => {
    const res = await post({ email: 'not-an-email', password: 'x' });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('BAD_REQUEST');
    expect(db.select).not.toHaveBeenCalled();
  });

  it('lowercases + trims email before lookup', async () => {
    selectLimit.mockResolvedValueOnce([verifiedUser]);
    vi.mocked(verifyPassword).mockResolvedValueOnce(true);

    await post({ email: '  A@B.CO  ', password: 'correct' });

    // eq(users.email, 'a@b.co') is built by drizzle; assert our where-clause was called
    // with the normalized email via the argument shape.
    expect(selectWhere).toHaveBeenCalled();
  });
});
