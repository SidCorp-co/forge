import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: TEST_SECRET,
    NODE_ENV: 'test',
    APP_BASE_URL: 'https://web.example.test',
    OAUTH_REDIRECT_BASE: 'https://api.example.test',
    GITHUB_OAUTH_CLIENT_ID: 'gh-id',
    GITHUB_OAUTH_CLIENT_SECRET: 'gh-secret',
    AUTH_COOKIE_DOMAIN: undefined,
  },
}));

vi.mock('../../lib/feature-flags.js', () => ({
  isEnabled: () => true,
}));

// Stub the provider impl so handleCallback's token-exchange step returns a
// deterministic identity without doing real HTTP.
const callbackStub = vi.fn();
vi.mock('./github.js', () => ({
  githubProvider: {
    buildAuthorizeUrl: vi.fn(),
    callback: (...args: unknown[]) => callbackStub(...args),
  },
}));
vi.mock('./oidc-provider.js', () => ({
  googleProvider: { buildAuthorizeUrl: vi.fn(), callback: vi.fn() },
  oidcProvider: { buildAuthorizeUrl: vi.fn(), callback: vi.fn() },
}));

const oauthLimit = vi.fn();
const usersUpdateWhere = vi.fn(() => Promise.resolve());
const usersUpdateSet = vi.fn(() => ({ where: usersUpdateWhere }));
const dbUpdate = vi.fn(() => ({ set: usersUpdateSet }));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: oauthLimit })),
      })),
    })),
    update: dbUpdate,
  },
}));

// Capture setAuthCookie so we can assert the reauth path NEVER calls it.
const setAuthCookieMock = vi.fn();
vi.mock('../cookie.js', () => ({
  setAuthCookie: (...args: unknown[]) => setAuthCookieMock(...args),
  AUTH_COOKIE_NAME: 'forge_auth',
}));

const { signState, STATE_COOKIE_NAME } = await import('./state.js');
const { handleCallback } = await import('./handler.js');

function buildApp() {
  const app = new Hono();
  app.get('/api/auth/oauth/:provider/callback', (c) =>
    handleCallback(c, c.req.param('provider') as 'github'),
  );
  return app;
}

const USER_ID = '00000000-0000-0000-0000-0000000000aa';
const OTHER_USER_ID = '00000000-0000-0000-0000-0000000000bb';
const PROVIDER_ACCOUNT_ID = 'gh-account-1';

beforeEach(() => {
  vi.clearAllMocks();
  oauthLimit.mockReset();
  usersUpdateSet.mockClear();
  usersUpdateWhere.mockClear();
  setAuthCookieMock.mockClear();
  callbackStub.mockReset();
  callbackStub.mockResolvedValue({
    providerAccountId: PROVIDER_ACCOUNT_ID,
    email: 'sso@example.com',
    emailVerified: true,
  });
});

async function makeReauthState(uid: string | undefined, returnPath = '/settings/tokens') {
  return signState({
    p: 'github',
    n: 'state-nonce',
    v: 'pkce-verifier',
    r: returnPath,
    mode: 'reauth',
    ...(uid ? { uid } : {}),
  });
}

describe('oauth callback — mode=reauth', () => {
  it('stamps lastFreshAuthAt and never sets the auth cookie on identity match', async () => {
    const cookie = await makeReauthState(USER_ID);
    oauthLimit.mockResolvedValueOnce([{ userId: USER_ID }]);

    const res = await buildApp().request(
      '/api/auth/oauth/github/callback?code=c&state=state-nonce',
      { headers: { cookie: `${STATE_COOKIE_NAME}=${cookie}` } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://web.example.test/settings/tokens?reauth=ok',
    );
    expect(dbUpdate).toHaveBeenCalledTimes(1);
    expect(usersUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ lastFreshAuthAt: expect.any(Date) }),
    );
    expect(setAuthCookieMock).not.toHaveBeenCalled();
  });

  it('appends with & when the return path already carries a query string', async () => {
    const cookie = await makeReauthState(USER_ID, '/settings?tab=tokens');
    oauthLimit.mockResolvedValueOnce([{ userId: USER_ID }]);

    const res = await buildApp().request(
      '/api/auth/oauth/github/callback?code=c&state=state-nonce',
      { headers: { cookie: `${STATE_COOKIE_NAME}=${cookie}` } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://web.example.test/settings?tab=tokens&reauth=ok',
    );
  });

  it('redirects with identity_mismatch when the linked row belongs to a different user', async () => {
    const cookie = await makeReauthState(USER_ID);
    oauthLimit.mockResolvedValueOnce([{ userId: OTHER_USER_ID }]);

    const res = await buildApp().request(
      '/api/auth/oauth/github/callback?code=c&state=state-nonce',
      { headers: { cookie: `${STATE_COOKIE_NAME}=${cookie}` } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://web.example.test/settings/tokens?reauth_error=identity_mismatch',
    );
    expect(dbUpdate).not.toHaveBeenCalled();
    expect(setAuthCookieMock).not.toHaveBeenCalled();
  });

  it('redirects with identity_mismatch when no oauth_accounts row exists', async () => {
    const cookie = await makeReauthState(USER_ID);
    oauthLimit.mockResolvedValueOnce([]);

    const res = await buildApp().request(
      '/api/auth/oauth/github/callback?code=c&state=state-nonce',
      { headers: { cookie: `${STATE_COOKIE_NAME}=${cookie}` } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://web.example.test/settings/tokens?reauth_error=identity_mismatch',
    );
    expect(dbUpdate).not.toHaveBeenCalled();
    expect(setAuthCookieMock).not.toHaveBeenCalled();
  });

  it('refuses to stamp when the state cookie has no uid', async () => {
    const cookie = await makeReauthState(undefined);

    const res = await buildApp().request(
      '/api/auth/oauth/github/callback?code=c&state=state-nonce',
      { headers: { cookie: `${STATE_COOKIE_NAME}=${cookie}` } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://web.example.test/settings/tokens?reauth_error=identity_mismatch',
    );
    expect(dbUpdate).not.toHaveBeenCalled();
    expect(setAuthCookieMock).not.toHaveBeenCalled();
  });
});
