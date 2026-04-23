import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

type UserRow = { id: string; email: string; emailVerifiedAt: Date | null };

let userRows: UserRow[] = [];
let lastQueriedId: string | null = null;

vi.mock('../db/client.js', () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: (expr: unknown) => {
      // drizzle's eq(...) returns an opaque SQL expression; capture the id
      // via a side channel so each test can set the expected user id.
      void expr;
      return chain;
    },
    limit: async (_n: number) => userRows,
  };
  return { db: chain };
});

// Intercept eq() so the test can observe which user id was queried.
vi.mock('drizzle-orm', async (orig) => {
  const mod = (await orig()) as Record<string, unknown>;
  return {
    ...mod,
    eq: (_col: unknown, val: unknown) => {
      lastQueriedId = typeof val === 'string' ? val : null;
      return { _: 'eq', val };
    },
  };
});

const { errorHandler } = await import('./error.js');
const requireUserMod = await import('./require-user.js');
const { requireUser } = requireUserMod;
type UserVars = import('./require-user.js').UserVars;
const { AUTH_COOKIE_NAME } = await import('../auth/cookie.js');
const { signUserToken } = await import('../auth/jwt.js');

function makeApp() {
  const app = new Hono<{ Variables: UserVars }>();
  app.use('*', requireUser());
  app.get('/me', (c) => c.json(c.get('user')));
  // errorHandler is typed for RequestIdVars; the JSON body shape is identical.
  app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
  return app;
}

const testUser: UserRow = {
  id: 'user-123',
  email: 'alice@example.com',
  emailVerifiedAt: null,
};

async function signExpired(userId: string): Promise<string> {
  const key = new TextEncoder().encode(TEST_SECRET);
  return new SignJWT({ typ: 'user' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
    .sign(key);
}

beforeEach(() => {
  userRows = [testUser];
  lastQueriedId = null;
});

describe('requireUser middleware', () => {
  it('authenticates via Authorization: Bearer <token> and attaches user', async () => {
    const app = makeApp();
    const token = await signUserToken(testUser.id);
    const res = await app.request('/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UserRow;
    expect(body.id).toBe(testUser.id);
    expect(body.email).toBe(testUser.email);
    expect(lastQueriedId).toBe(testUser.id);
  });

  it('authenticates via the forge_auth cookie', async () => {
    const app = makeApp();
    const token = await signUserToken(testUser.id);
    const res = await app.request('/me', {
      headers: { cookie: `${AUTH_COOKIE_NAME}=${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UserRow;
    expect(body.id).toBe(testUser.id);
  });

  it('prefers cookie over Authorization header when both present', async () => {
    const app = makeApp();
    const cookieToken = await signUserToken('cookie-user');
    const headerToken = await signUserToken('header-user');
    userRows = [{ id: 'cookie-user', email: 'c@x', emailVerifiedAt: null }];
    const res = await app.request('/me', {
      headers: {
        cookie: `${AUTH_COOKIE_NAME}=${cookieToken}`,
        authorization: `Bearer ${headerToken}`,
      },
    });
    expect(res.status).toBe(200);
    expect(lastQueriedId).toBe('cookie-user');
  });

  it('returns 401 UNAUTHENTICATED when no token is provided', async () => {
    const app = makeApp();
    const res = await app.request('/me');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHENTICATED');
  });

  it('returns 401 UNAUTHENTICATED for a malformed token', async () => {
    const app = makeApp();
    const res = await app.request('/me', {
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHENTICATED');
  });

  it('returns 401 UNAUTHENTICATED for a token signed with a different secret', async () => {
    const app = makeApp();
    const wrong = new TextEncoder().encode('different-secret-at-least-32-chars-long');
    const forged = await new SignJWT({ typ: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-evil')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(wrong);
    const res = await app.request('/me', {
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHENTICATED');
  });

  it('returns 401 UNAUTHENTICATED for a token with a non-user typ claim', async () => {
    const app = makeApp();
    const key = new TextEncoder().encode(TEST_SECRET);
    const deviceToken = await new SignJWT({ typ: 'device' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('device-1')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    const res = await app.request('/me', {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHENTICATED');
  });

  it('returns 401 TOKEN_EXPIRED for an expired token', async () => {
    const app = makeApp();
    const token = await signExpired(testUser.id);
    const res = await app.request('/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('TOKEN_EXPIRED');
  });

  it('returns 401 UNAUTHENTICATED when the user row is missing', async () => {
    const app = makeApp();
    userRows = [];
    const token = await signUserToken('ghost-user');
    const res = await app.request('/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHENTICATED');
  });
});
