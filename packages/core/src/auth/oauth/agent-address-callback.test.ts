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

const dbInsert = vi.fn();
const dbTransaction = vi.fn();
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: oauthLimit })),
      })),
    })),
    update: dbUpdate,
    insert: dbInsert,
    transaction: dbTransaction,
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

beforeEach(() => {
  vi.clearAllMocks();
  oauthLimit.mockReset();
  callbackStub.mockReset();
});

async function signIn(email: string) {
  callbackStub.mockResolvedValue({ providerAccountId: 'gh-1', email, emailVerified: true });
  const cookie = await signState({
    p: 'github',
    n: 'state-nonce',
    v: 'pkce-verifier',
    r: '/projects',
  });
  return buildApp().request('/api/auth/oauth/github/callback?code=c&state=state-nonce', {
    headers: { cookie: `${STATE_COOKIE_NAME}=${cookie}` },
  });
}

/**
 * ISS-1421 round 2 — a first sign-in through an identity provider creates an account and its
 * personal org, and an existing account is linked by its verified address. An address on the
 * domain Forge mints agent accounts on is neither: a person holding Forge's address is shown as
 * Forge, and Forge can then no longer mint its own account there.
 */
describe('oauth callback — an address Forge mints (criterion 36)', () => {
  it.each([
    'forge@agents.forge.invalid',
    'Forge@Agents.Forge.Invalid',
    'bot.0a1b2c@agents.forge.invalid',
  ])(
    'creates and links no account for %s, and sends the person back to sign-in saying why',
    async (email) => {
      oauthLimit.mockResolvedValue([]);

      const res = await signIn(email);

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(
        'https://web.example.test/login?oauth_error=agent_address',
      );
      expect(dbInsert).not.toHaveBeenCalled();
      expect(dbTransaction).not.toHaveBeenCalled();
      expect(setAuthCookieMock).not.toHaveBeenCalled();
    },
  );

  it('signs in an ordinary address it already links', async () => {
    oauthLimit.mockResolvedValueOnce([{ userId: '00000000-0000-0000-0000-0000000000aa' }]);
    oauthLimit.mockResolvedValue([{ kind: 'human' }]);

    const res = await signIn('a.person@example.com');

    expect(res.headers.get('location')).not.toContain('oauth_error');
  });
});
