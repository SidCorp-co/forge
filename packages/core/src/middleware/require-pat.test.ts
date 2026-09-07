/**
 * `/mcp` credential middleware unit tests (ISS-150, narrowed by ISS-931).
 *
 * One species authenticates: a PAT. A device token is refused BY NAME, the
 * refusal never reaches `verifyDeviceToken`, and the principal carries the
 * job/session the token names. Plus the 401 envelopes and the rate limit.
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
}));

vi.mock('../auth/mcp-audit.js', () => ({
  writeMcpAudit: vi.fn(),
}));

const { errorHandler } = await import('./error.js');
const { requirePat, __resetPatBuckets } = await import('./require-pat.js');
const { verifyDeviceToken } = await import('../auth/deviceToken.js');
const { verifyPat } = await import('../auth/pat.js');
const { writeMcpAudit } = await import('../auth/mcp-audit.js');

const PAT_TOKEN = `forge_pat_dev_${'a'.repeat(64)}`;

const testDevice = {
  id: 'dev-1',
  ownerId: 'user-1',
  name: 'macbook',
  platform: 'macos' as const,
  agentVersion: null,
  tokenHash: 'hash',
  tokenPrefix: 'abcd1234',
  disabledAt: null,
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
  disabledAt: null,
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
  app.use('*', requirePat());
  app.get('/whoami', (c) => c.json(c.get('principal' as never)));
  app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
  return app;
}

beforeEach(() => {
  vi.mocked(verifyDeviceToken).mockReset();
  vi.mocked(verifyPat).mockReset();
  vi.mocked(writeMcpAudit).mockReset();
  __resetPatBuckets();
});

describe('requirePat middleware (ISS-150, ISS-931)', () => {
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
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
  });

  // cm:guard THE point of ISS-931, and the assertion that keeps it: a device token must be refused WITHOUT `verifyDeviceToken` being consulted. A `toBe(401)` alone would stay green against a middleware that verified the device and then rejected it, which is a second live credential path wearing a 401.
  it('refuses a device token by name and never reaches the device verifier', async () => {
    vi.mocked(verifyDeviceToken).mockResolvedValue(testDevice as never);
    const app = makeApp();
    const res = await app.request('/whoami', {
      headers: { authorization: 'Bearer legacy-device-token-string' },
    });
    expect(res.status).toBe(401);
    expect(vi.mocked(verifyDeviceToken)).not.toHaveBeenCalled();
    expect(vi.mocked(verifyPat)).not.toHaveBeenCalled();
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('UNAUTHENTICATED');
    // cm:guard assert the CLASS and the remedy, not just the 401: an operator reading this holds a real, paired, unexpired credential on the wrong plane, and `invalid personal access token` would send them hunting a PAT problem that does not exist.
    expect(body.message).toMatch(/device tokens no longer authenticate \/mcp/i);
    expect(body.message).toMatch(/newer forge-runner/i);
    expect(body.message).toMatch(/\/ws/);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="forge-mcp", error="invalid_token"',
    );
  });

  it('carries the job a `job:` token names onto the principal', async () => {
    const jobId = '77777777-7777-4777-8777-777777777777';
    vi.mocked(verifyPat).mockResolvedValue({
      row: { ...testPatRow, name: `job:${jobId}` },
    } as never);
    const app = makeApp();
    const res = await app.request('/whoami', {
      headers: { authorization: `Bearer ${PAT_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agency: string;
      machine: { kind: string; id: string } | null;
    };
    expect(body.machine).toEqual({ kind: 'job', id: jobId });
    expect(body.agency).toBe('agent');
  });

  it('carries the session a `session:` token names, and null for a person', async () => {
    const sessionId = '88888888-8888-4888-8888-888888888888';
    vi.mocked(verifyPat).mockResolvedValue({
      row: { ...testPatRow, name: `session:${sessionId}` },
    } as never);
    let res = await makeApp().request('/whoami', {
      headers: { authorization: `Bearer ${PAT_TOKEN}` },
    });
    expect(((await res.json()) as { machine: unknown }).machine).toEqual({
      kind: 'session',
      id: sessionId,
    });

    __resetPatBuckets();
    vi.mocked(verifyPat).mockResolvedValue({ row: { ...testPatRow, name: 'my laptop' } } as never);
    res = await makeApp().request('/whoami', {
      headers: { authorization: `Bearer ${PAT_TOKEN}` },
    });
    const body = (await res.json()) as { machine: unknown; agency: string };
    expect(body.machine).toBeNull();
    expect(body.agency).toBe('human');
  });

  it('returns 401 with bearer challenge when no Authorization header is provided', async () => {
    const app = makeApp();
    const res = await app.request('/whoami');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHENTICATED');
    // cm:why realm only, with no `error=`: RFC 6750 §3 reserves the error codes for a request that actually presented credentials
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="forge-mcp"');
  });

  it('returns 401 with invalid_request challenge for a non-Bearer scheme', async () => {
    const app = makeApp();
    const res = await app.request('/whoami', {
      headers: { authorization: 'Basic abc123' },
    });
    expect(res.status).toBe(401);
    // cm:why credentials WERE presented, in the wrong scheme: RFC 6750 §3 asks for `invalid_request` so a spec-aware client fixes the header instead of retrying the same value, and so an MCP client suppresses its OAuth DCR fallback
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="forge-mcp", error="invalid_request"',
    );
  });

  it('returns 401 with invalid_request challenge for "Bearer " with empty token', async () => {
    const app = makeApp();
    const res = await app.request('/whoami', {
      headers: { authorization: 'Bearer ' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="forge-mcp", error="invalid_request"',
    );
  });

  it('returns 401 with invalid_token challenge when verifyPat returns null for a PAT-shaped token', async () => {
    vi.mocked(verifyPat).mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request('/whoami', {
      headers: { authorization: `Bearer ${PAT_TOKEN}` },
    });
    expect(res.status).toBe(401);
    expect(vi.mocked(verifyDeviceToken)).not.toHaveBeenCalled();
    // cm:why token present but invalid: `error="invalid_token"` is what makes an MCP client surface the failure instead of falling back to OAuth DCR
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="forge-mcp", error="invalid_token"',
    );
  });

  it('returns 401 with invalid_token challenge for a bearer of no known shape', async () => {
    const app = makeApp();
    const res = await app.request('/whoami', {
      headers: { authorization: 'Bearer not-a-pat-or-device' },
    });
    expect(res.status).toBe(401);
    expect(vi.mocked(verifyDeviceToken)).not.toHaveBeenCalled();
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
    expect((await app.request('/whoami', { headers: hdrs })).status).toBe(200);
    expect((await app.request('/whoami', { headers: hdrs })).status).toBe(200);
    const res = await app.request('/whoami', { headers: hdrs });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('audits the first rejection of a window as rate_limited, once per window', async () => {
    vi.mocked(verifyPat).mockResolvedValue({
      row: { ...testPatRow, rateLimitMax: 1 },
    } as never);
    const app = makeApp();
    const hdrs = { authorization: `Bearer ${PAT_TOKEN}`, 'user-agent': 'node' };
    expect((await app.request('/whoami', { headers: hdrs })).status).toBe(200);
    expect(vi.mocked(writeMcpAudit)).not.toHaveBeenCalled();
    expect((await app.request('/whoami', { headers: hdrs })).status).toBe(429);
    expect((await app.request('/whoami', { headers: hdrs })).status).toBe(429);
    expect((await app.request('/whoami', { headers: hdrs })).status).toBe(429);
    expect(vi.mocked(writeMcpAudit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeMcpAudit)).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: testPatRow.id,
        userId: testPatRow.userId,
        tool: 'rate_limit',
        action: 'GET /whoami',
        resultCode: 'rate_limited',
        userAgent: 'node',
      }),
    );
  });

  it('keeps rejecting for the whole window and never revokes the token', async () => {
    vi.mocked(verifyPat).mockResolvedValue({
      row: { ...testPatRow, rateLimitMax: 1 },
    } as never);
    const app = makeApp();
    const hdrs = { authorization: `Bearer ${PAT_TOKEN}` };
    expect((await app.request('/whoami', { headers: hdrs })).status).toBe(200);
    for (let i = 0; i < 10; i += 1) {
      expect((await app.request('/whoami', { headers: hdrs })).status).toBe(429);
    }
    const pat = await import('../auth/pat.js');
    expect('forceRevokePat' in pat).toBe(false);
  });
});
