/**
 * Dispatcher middleware unit tests (ISS-150).
 *
 * Token-format routing (PAT vs device), 401 envelopes, rate-limit + auto-revoke.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    PAT_PEPPER: 'pat-test-pepper',
    RATE_LIMIT_PAT_MAX: 60,
  },
}));

vi.mock('../auth/deviceToken.js', () => ({
  verifyDeviceToken: vi.fn(),
}));

vi.mock('../auth/pat.js', () => ({
  verifyPat: vi.fn(),
  touchPatUsage: vi.fn(),
  forceRevokePat: vi.fn(),
}));

const { errorHandler } = await import('./error.js');
const { requirePatOrDevice, __resetPatBuckets } = await import('./require-pat-or-device.js');
const { verifyDeviceToken } = await import('../auth/deviceToken.js');
const { verifyPat, forceRevokePat } = await import('../auth/pat.js');

const PAT_TOKEN = 'forge_pat_dev_' + 'a'.repeat(64);

const testDevice = {
  id: 'dev-1',
  ownerId: 'user-1',
  name: 'macbook',
  platform: 'macos' as const,
  agentVersion: null,
  tokenHash: 'hash',
  tokenPrefix: 'abcd1234',
  status: 'online' as const,
  lastSeenAt: null,
  pairedAt: new Date(0),
  capabilities: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const testPatRow = {
  id: '00000000-0000-4000-8000-0000000000aa',
  userId: 'pat-user-1',
  name: 'cli',
  tokenHash: '',
  tokenPrefix: PAT_TOKEN.slice(0, 18),
  scopes: ['read', 'write'],
  projectIds: null,
  expiresAt: null,
  createdAt: new Date(0),
  lastUsedAt: null,
  lastUsedIp: null,
  revokedAt: null,
  rateLimitMax: null,
};

function makeApp() {
  const app = new Hono();
  app.use('*', requirePatOrDevice());
  app.get('/whoami', (c) => c.json(c.get('principal' as never)));
  app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
  return app;
}

beforeEach(() => {
  vi.mocked(verifyDeviceToken).mockReset();
  vi.mocked(verifyPat).mockReset();
  vi.mocked(forceRevokePat).mockReset();
  __resetPatBuckets();
});

describe('requirePatOrDevice middleware (ISS-150)', () => {
  it('routes a forge_pat_* token to the PAT verifier and attaches a PAT principal', async () => {
    vi.mocked(verifyPat).mockResolvedValue({ row: testPatRow } as never);
    const app = makeApp();
    const res = await app.request('/whoami', {
      headers: { authorization: `Bearer ${PAT_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; userId: string; tokenId: string };
    expect(body.kind).toBe('pat');
    expect(body.userId).toBe(testPatRow.userId);
    expect(body.tokenId).toBe(testPatRow.id);
    expect(vi.mocked(verifyPat)).toHaveBeenCalledWith(PAT_TOKEN);
    expect(vi.mocked(verifyDeviceToken)).not.toHaveBeenCalled();
    // Success path must not leak the bearer challenge header.
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
  });

  it('routes a non-PAT token to verifyDeviceToken and attaches a device principal', async () => {
    vi.mocked(verifyDeviceToken).mockResolvedValue(testDevice as never);
    const app = makeApp();
    const res = await app.request('/whoami', {
      headers: { authorization: 'Bearer legacy-device-token-string' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; device: { id: string } };
    expect(body.kind).toBe('device');
    expect(body.device.id).toBe(testDevice.id);
    expect(vi.mocked(verifyPat)).not.toHaveBeenCalled();
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
  });

  it('returns 401 with bearer challenge when no Authorization header is provided', async () => {
    const app = makeApp();
    const res = await app.request('/whoami');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHENTICATED');
    // Missing-token case: realm only, no error= (RFC 6750 §3).
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="forge-mcp"');
  });

  it('returns 401 with bearer challenge for a non-Bearer scheme', async () => {
    const app = makeApp();
    const res = await app.request('/whoami', {
      headers: { authorization: 'Basic abc123' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="forge-mcp"');
  });

  it('returns 401 with invalid_token challenge when verifyPat returns null for a PAT-shaped token', async () => {
    vi.mocked(verifyPat).mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request('/whoami', {
      headers: { authorization: `Bearer ${PAT_TOKEN}` },
    });
    expect(res.status).toBe(401);
    // device path must not be tried — token shape is PAT.
    expect(vi.mocked(verifyDeviceToken)).not.toHaveBeenCalled();
    // Token-present-but-invalid: error="invalid_token" tells MCP clients to
    // surface the failure directly instead of falling back to OAuth DCR.
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="forge-mcp", error="invalid_token"',
    );
  });

  it('returns 401 with invalid_token challenge when verifyDeviceToken returns null for a non-PAT token', async () => {
    vi.mocked(verifyDeviceToken).mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request('/whoami', {
      headers: { authorization: 'Bearer not-a-pat-or-device' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="forge-mcp", error="invalid_token"',
    );
  });

  it('enforces per-PAT rate limit and returns 429 with Retry-After', async () => {
    vi.mocked(verifyPat).mockResolvedValue({
      row: { ...testPatRow, rateLimitMax: 2 },
    } as never);
    const app = makeApp();
    const hdrs = { authorization: `Bearer ${PAT_TOKEN}` };
    // First two requests pass.
    expect((await app.request('/whoami', { headers: hdrs })).status).toBe(200);
    expect((await app.request('/whoami', { headers: hdrs })).status).toBe(200);
    // Third trips the limit.
    const res = await app.request('/whoami', { headers: hdrs });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    // Single 429 does not auto-revoke (threshold is 3 breaches/hour).
    expect(vi.mocked(forceRevokePat)).not.toHaveBeenCalled();
  });
});
