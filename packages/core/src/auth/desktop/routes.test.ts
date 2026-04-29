import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';
const APP_BASE_URL = 'https://app.example.com';

// === Module mocks ===

vi.mock('../../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    APP_BASE_URL,
    JWT_SECRET: TEST_SECRET,
    GITHUB_OAUTH_CLIENT_ID: 'gh-id',
    GITHUB_OAUTH_CLIENT_SECRET: 'gh-secret',
  },
}));

const isEnabled = vi.fn();
vi.mock('../../lib/feature-flags.js', () => ({
  isEnabled,
}));

const insertValues = vi.fn(async () => undefined);
const updateReturning = vi.fn();
const selectLimit = vi.fn();

vi.mock('../../db/client.js', () => ({
  db: {
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: updateReturning })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: selectLimit })),
      })),
    })),
  },
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { desktopRoutes } = await import('./routes.js');
const { errorHandler } = await import('../../middleware/error.js');
const { requestId } = await import('../../middleware/request-id.js');
const { signUserToken } = await import('../jwt.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/auth', desktopRoutes);
  app.onError(errorHandler);
  return app;
}

function sha256B64url(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('base64url');
}

function randomB64url(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

beforeEach(() => {
  vi.clearAllMocks();
  isEnabled.mockReturnValue(true);
  insertValues.mockClear();
  updateReturning.mockReset();
  selectLimit.mockReset();
});

// =====================================================================
// GET /desktop/start
// =====================================================================

describe('GET /api/auth/desktop/start', () => {
  const verifier = randomB64url(32);
  const challenge = sha256B64url(verifier);

  it('returns 404 when desktopOauth flag is off', async () => {
    isEnabled.mockReturnValueOnce(false);
    const res = await buildApp().request(
      `/api/auth/desktop/start?provider=github&code_challenge=${challenge}&code_challenge_method=S256`,
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 when provider is missing', async () => {
    const res = await buildApp().request(
      `/api/auth/desktop/start?code_challenge=${challenge}&code_challenge_method=S256`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_PROVIDER');
  });

  it('returns 400 when provider is not in the allow-list', async () => {
    const res = await buildApp().request(
      `/api/auth/desktop/start?provider=facebook&code_challenge=${challenge}&code_challenge_method=S256`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_PROVIDER');
  });

  it('returns 400 when code_challenge_method is plain (RFC 7636 §4.4.2)', async () => {
    const res = await buildApp().request(
      `/api/auth/desktop/start?provider=github&code_challenge=${challenge}&code_challenge_method=plain`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_PKCE_METHOD');
  });

  it('returns 400 when code_challenge is too short', async () => {
    const res = await buildApp().request(
      `/api/auth/desktop/start?provider=github&code_challenge=tooshort&code_challenge_method=S256`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_PKCE_CHALLENGE');
  });

  it('returns 400 when code_challenge contains non-b64url chars', async () => {
    const bad = '!'.repeat(43);
    const res = await buildApp().request(
      `/api/auth/desktop/start?provider=github&code_challenge=${bad}&code_challenge_method=S256`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_PKCE_CHALLENGE');
  });

  it('happy path — persists handoff row and redirects to /oauth/<provider>/start', async () => {
    const res = await buildApp().request(
      `/api/auth/desktop/start?provider=github&code_challenge=${challenge}&code_challenge_method=S256`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    expect(insertValues).toHaveBeenCalledTimes(1);
    const insertedRow = (insertValues.mock.calls as unknown as unknown[][])[0]?.[0] as {
      id: string;
      provider: string;
      codeChallenge: string;
      expiresAt: Date;
    };
    expect(insertedRow).toMatchObject({
      provider: 'github',
      codeChallenge: challenge,
    });
    expect(insertedRow.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(insertedRow.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/api/auth/oauth/github/start?redirect=');
    // The redirect param must be url-encoded and carry the handoff_id.
    expect(decodeURIComponent(location.split('redirect=')[1] ?? '')).toBe(
      `/auth/desktop/handoff?handoff=${encodeURIComponent(insertedRow.id)}`,
    );
  });

  it('returns 404 PROVIDER_NOT_ENABLED when env vars for the provider are unset', async () => {
    // google requires GOOGLE_OIDC_CLIENT_ID/SECRET — not set in our env mock.
    const res = await buildApp().request(
      `/api/auth/desktop/start?provider=google&code_challenge=${challenge}&code_challenge_method=S256`,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('PROVIDER_NOT_ENABLED');
  });
});

// =====================================================================
// POST /desktop/issue-code
// =====================================================================

describe('POST /api/auth/desktop/issue-code', () => {
  const userId = 'b8a2c1c2-3a44-4d6c-9b0e-000000000001';
  let bearer = '';

  beforeEach(async () => {
    bearer = `Bearer ${await signUserToken(userId)}`;
  });

  function postIssue(body: unknown, headers: Record<string, string> = {}) {
    return buildApp().request('/api/auth/desktop/issue-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('returns 401 without auth', async () => {
    const res = await postIssue({ handoff_id: 'h1' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when handoff_id is missing', async () => {
    const res = await postIssue({}, { authorization: bearer });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_HANDOFF_ID');
  });

  it('returns 410 when no live row matches (consumed / expired / unknown id)', async () => {
    updateReturning.mockResolvedValueOnce([]);
    const res = await postIssue({ handoff_id: 'unknown' }, { authorization: bearer });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('HANDOFF_GONE');
  });

  it('happy path — sets code_hash + user_id and returns one-time code', async () => {
    updateReturning.mockResolvedValueOnce([{ id: 'h1' }]);
    const res = await postIssue({ handoff_id: 'h1' }, { authorization: bearer });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string };
    expect(body.code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.code.length).toBeGreaterThanOrEqual(43);
  });
});

// =====================================================================
// POST /desktop/exchange
// =====================================================================

describe('POST /api/auth/desktop/exchange', () => {
  const userId = 'b8a2c1c2-3a44-4d6c-9b0e-000000000002';
  const verifier = randomB64url(32);
  const challenge = sha256B64url(verifier);
  const code = randomB64url(32);

  function postExchange(body: unknown) {
    return buildApp().request('/api/auth/desktop/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('returns 400 when body fields are missing', async () => {
    const res = await postExchange({ handoff_id: 'h1' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_BODY');
  });

  it('returns 400 INVALID_PKCE_VERIFIER on a malformed verifier', async () => {
    const res = await postExchange({
      handoff_id: 'h1',
      code: 'somecode',
      code_verifier: 'short',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_PKCE_VERIFIER');
  });

  it('returns 400 HANDOFF_INVALID when no row matches (single-use atomic check)', async () => {
    updateReturning.mockResolvedValueOnce([]);
    const res = await postExchange({
      handoff_id: 'h1',
      code,
      code_verifier: verifier,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('HANDOFF_INVALID');
  });

  it('returns 400 PKCE_MISMATCH when verifier does not hash to the stored challenge', async () => {
    updateReturning.mockResolvedValueOnce([
      { userId, codeChallenge: sha256B64url('different-verifier-entirely-aaaa') },
    ]);
    const res = await postExchange({
      handoff_id: 'h1',
      code,
      code_verifier: verifier,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('PKCE_MISMATCH');
  });

  it('happy path — returns { token, user } with verified PKCE', async () => {
    updateReturning.mockResolvedValueOnce([{ userId, codeChallenge: challenge }]);
    selectLimit.mockResolvedValueOnce([{ id: userId, email: 'desk@example.com' }]);

    const res = await postExchange({
      handoff_id: 'h1',
      code,
      code_verifier: verifier,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { id: string; email: string } };
    expect(body.user).toEqual({ id: userId, email: 'desk@example.com' });
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.').length).toBe(3); // JWT shape
  });

  it('returns 500 HANDOFF_USER_MISSING when user row has been deleted', async () => {
    updateReturning.mockResolvedValueOnce([{ userId, codeChallenge: challenge }]);
    selectLimit.mockResolvedValueOnce([]);
    const res = await postExchange({
      handoff_id: 'h1',
      code,
      code_verifier: verifier,
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('HANDOFF_USER_MISSING');
  });
});
