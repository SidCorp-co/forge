/**
 * `/mcp` credential middleware unit tests (ISS-150, narrowed by ISS-931).
 *
 * One species authenticates: a PAT. A device token is refused BY NAME, the
 * refusal names the credential class, and the principal carries the
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
    RATE_LIMIT_PAT_READ_MAX: 2400,
    RATE_LIMIT_PAT_WRITE_MAX: 600,
  },
}));

vi.mock('../auth/pat.js', () => ({
  verifyPat: vi.fn(),
  touchPatUsage: vi.fn(),
}));

vi.mock('../auth/mcp-audit.js', () => ({
  writeMcpAudit: vi.fn(),
}));

const { errorHandler } = await import('./error.js');
const { authenticatePat, requirePat, __resetPatBuckets } = await import('./require-pat.js');
const { verifyPat } = await import('../auth/pat.js');
const { writeMcpAudit } = await import('../auth/mcp-audit.js');

const PAT_TOKEN = `forge_pat_dev_${'a'.repeat(64)}`;

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
  vi.mocked(verifyPat).mockReset();
  vi.mocked(writeMcpAudit).mockReset();
  __resetPatBuckets();
});

describe('requirePat middleware (ISS-150, ISS-931)', () => {
  it('routes a forge_pat_* token to the PAT verifier and attaches a PAT principal', async () => {
    vi.mocked(verifyPat).mockResolvedValue({ row: testPatRow, ownerKind: 'human' } as never);
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
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
  });

  // cm:guard ISS-931 asserted this refusal happened WITHOUT `verifyDeviceToken` being consulted, because a bare `toBe(401)` would stay green against a middleware that verified a device and then rejected it. ISS-932 deleted that verifier from the process, so the surviving half is that `verifyPat` is not consulted either and the message still names the class — a pre-ISS-932 box reads this line and nothing else.
  it('refuses the opaque token a pre-ISS-932 box holds, by name', async () => {
    const app = makeApp();
    const res = await app.request('/whoami', {
      headers: { authorization: 'Bearer legacy-device-token-string' },
    });
    expect(res.status).toBe(401);
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

  // cm:guard the name is INERT — a person may hand-mint a token called `job:...` and it must reach `human`, because agency is a property of the PRINCIPAL since ISS-932 wave 4. The name-reading predicate this replaced stamped such a token `agent`, which let a hand-made credential skip the ISS-786/812 evidence gates.
  it('stamps `human` on a person-owned token whose name imitates a machine token', async () => {
    const jobId = '77777777-7777-4777-8777-777777777777';
    vi.mocked(verifyPat).mockResolvedValue({
      ownerKind: 'human',
      row: { ...testPatRow, name: `job:${jobId}` },
    } as never);
    const app = makeApp();
    const res = await app.request('/whoami', {
      headers: { authorization: `Bearer ${PAT_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agency: string; machine?: unknown };
    expect(body.agency).toBe('human');
    expect(body.machine).toBeUndefined();
  });

  it('stamps `agent` from the owner alone, whatever the token is called', async () => {
    for (const name of ['session:88888888-8888-4888-8888-888888888888', 'a plain name']) {
      __resetPatBuckets();
      vi.mocked(verifyPat).mockResolvedValue({
        ownerKind: 'agent',
        row: { ...testPatRow, name },
      } as never);
      const res = await makeApp().request('/whoami', {
        headers: { authorization: `Bearer ${PAT_TOKEN}` },
      });
      expect(((await res.json()) as { agency: string }).agency).toBe('agent');
    }
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
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="forge-mcp", error="invalid_token"',
    );
  });

  it('enforces per-PAT rate limit and returns 429 with Retry-After', async () => {
    vi.mocked(verifyPat).mockResolvedValue({
      ownerKind: 'human',
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
      ownerKind: 'human',
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
      ownerKind: 'human',
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

/**
 * ISS-961 — reads and writes are two budgets on one token, and the 429 says
 * enough for a client to act without guessing.
 *
 * The falsifying case is `a read that spends its whole budget still writes`:
 * every other assertion here passes for the single shared bucket this
 * replaced, because a shared bucket also returns 429 and also carries
 * `Retry-After`. Only the cross-class probe tells the two apart.
 */
describe('requirePat rate limit, split by request class', () => {
  const RULES_READ_MAX = 2400;

  function classedApp(requestClass: 'read' | 'write') {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('patRequestClass' as never, requestClass as never);
      await next();
    });
    app.use('*', requirePat());
    app.get('/read', (c) => c.json({ ok: true }));
    app.post('/write', (c) => c.json({ ok: true }));
    app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
    return app;
  }

  const hdrs = { authorization: `Bearer ${PAT_TOKEN}` };

  function tokenWith(rateLimitMax: number | null) {
    vi.mocked(verifyPat).mockResolvedValue({
      ownerKind: 'human',
      row: { ...testPatRow, rateLimitMax },
    } as never);
  }

  it('lets a token with no override spend the whole read budget in one window', async () => {
    tokenWith(null);
    const app = classedApp('read');
    for (let i = 0; i < RULES_READ_MAX; i += 1) {
      const res = await app.request('/read', { headers: hdrs });
      if (res.status !== 200) throw new Error(`refused at request ${i + 1}: ${res.status}`);
    }
    expect((await app.request('/read', { headers: hdrs })).status).toBe(429);
  });

  // cm:guard THE falsifying assertion for the whole split. A single shared bucket passes every other test in this block; only a write succeeding after the read budget is spent distinguishes two buckets from one, and that is the property ISS-961 was filed for.
  it('still accepts a write once the read budget is spent', async () => {
    tokenWith(3);
    const reads = classedApp('read');
    const writes = classedApp('write');
    expect((await reads.request('/read', { headers: hdrs })).status).toBe(200);
    expect((await reads.request('/read', { headers: hdrs })).status).toBe(200);
    expect((await reads.request('/read', { headers: hdrs })).status).toBe(200);
    expect((await reads.request('/read', { headers: hdrs })).status).toBe(429);

    expect((await writes.request('/write', { method: 'POST', headers: hdrs })).status).toBe(200);
  });

  it('does not let a write spend the read budget either', async () => {
    tokenWith(1);
    const reads = classedApp('read');
    const writes = classedApp('write');
    expect((await writes.request('/write', { method: 'POST', headers: hdrs })).status).toBe(200);
    expect((await writes.request('/write', { method: 'POST', headers: hdrs })).status).toBe(429);
    expect((await reads.request('/read', { headers: hdrs })).status).toBe(200);
  });

  it('sends Retry-After, X-RateLimit-Reset and the scope that refused', async () => {
    tokenWith(1);
    const app = classedApp('read');
    await app.request('/read', { headers: hdrs });
    const res = await app.request('/read', { headers: hdrs });
    expect(res.status).toBe(429);

    const retryAfter = Number(res.headers.get('Retry-After'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);

    const reset = Number(res.headers.get('X-RateLimit-Reset'));
    const nowSec = Math.ceil(Date.now() / 1000);
    expect(reset).toBeGreaterThanOrEqual(nowSec);
    expect(reset).toBeLessThanOrEqual(nowSec + 60);

    expect(res.headers.get('X-RateLimit-Scope')).toBe('read');
    expect(res.headers.get('X-RateLimit-Limit')).toBe('1');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
  });

  it('names the window, the limit, the remaining budget and the class in the body', async () => {
    tokenWith(1);
    const app = classedApp('write');
    await app.request('/write', { method: 'POST', headers: hdrs });
    const res = await app.request('/write', { method: 'POST', headers: hdrs });
    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      code: string;
      message: string;
      details: Record<string, unknown>;
    };
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.details).toMatchObject({
      windowSeconds: 60,
      limit: 1,
      remaining: 0,
      scope: 'write',
    });
    expect(body.details.retryAfterSeconds).toBe(Number(res.headers.get('Retry-After')));
    expect(body.message).toContain('60s');
    expect(body.message).toContain('write');
  });

  it('honours the header it sent: one wait of Retry-After seconds is enough', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-07T00:00:00.000Z'));
      tokenWith(1);
      const app = classedApp('read');
      expect((await app.request('/read', { headers: hdrs })).status).toBe(200);
      const refused = await app.request('/read', { headers: hdrs });
      expect(refused.status).toBe(429);

      const wait = Number(refused.headers.get('Retry-After'));
      vi.setSystemTime(new Date(Date.now() + wait * 1000));
      expect((await app.request('/read', { headers: hdrs })).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('audits the first rejection of each class separately, once per window', async () => {
    tokenWith(1);
    const reads = classedApp('read');
    const writes = classedApp('write');
    await reads.request('/read', { headers: hdrs });
    await reads.request('/read', { headers: hdrs });
    await reads.request('/read', { headers: hdrs });
    await writes.request('/write', { method: 'POST', headers: hdrs });
    await writes.request('/write', { method: 'POST', headers: hdrs });
    await writes.request('/write', { method: 'POST', headers: hdrs });

    expect(vi.mocked(writeMcpAudit)).toHaveBeenCalledTimes(2);
    const actions = vi.mocked(writeMcpAudit).mock.calls.map(([row]) => row.action);
    expect(actions).toEqual(['GET /read', 'POST /write']);
  });

  it('charges the write bucket when nothing upstream set a class', async () => {
    tokenWith(1);
    const app = new Hono();
    app.use('*', requirePat());
    app.get('/read', (c) => c.json({ ok: true }));
    app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
    await app.request('/read', { headers: hdrs });
    const res = await app.request('/read', { headers: hdrs });
    expect(res.status).toBe(429);
    expect(res.headers.get('X-RateLimit-Scope')).toBe('write');
  });
});

/**
 * `onVerified`, driven through the real function (ISS-974).
 *
 * `pat-accepted-permissions-header.test.ts` is one seam away: it mocks this
 * module and fires the callback from its own stub, so it proves what
 * `beginPatRequest` DOES with the callback and nothing about when
 * `authenticatePat` fires it. Move `onVerified?.()` below the rate-limit
 * rejection and that file stays green while a verified, throttled request
 * loses the accepted-permissions header on the wire. These two cases hold the
 * other side of the seam, which is the half criterion 28 turns on.
 */
describe('onVerified fires at verification and never at the outcome', () => {
  const hdrs = { Authorization: `Bearer ${PAT_TOKEN}` };

  function appCalling(fired: string[]) {
    const app = new Hono();
    app.use('*', async (c, next) => {
      const principal = await authenticatePat(c, PAT_TOKEN, 'read', () => {
        fired.push(`${c.req.method} ${c.req.path}`);
        c.header('X-Test-Verified', 'yes');
      });
      if (!principal) return c.json({ code: 'INVALID_TOKEN' }, 401);
      return next();
    });
    app.get('/read', (c) => c.json({ ok: true }));
    app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
    return app;
  }

  it('has already fired when the bucket refuses the request it verified', async () => {
    vi.mocked(verifyPat).mockResolvedValue({
      ownerKind: 'human',
      row: { ...testPatRow, rateLimitMax: 1 },
    } as never);
    const fired: string[] = [];
    const app = appCalling(fired);

    expect((await app.request('/read', { headers: hdrs })).status).toBe(200);
    const throttled = await app.request('/read', { headers: hdrs });

    expect(throttled.status).toBe(429);
    expect(fired).toEqual(['GET /read', 'GET /read']);
    expect(throttled.headers.get('X-Test-Verified')).toBe('yes');
  });

  it('never fires for a token that does not verify, whatever is answered after', async () => {
    vi.mocked(verifyPat).mockResolvedValue(null);
    const fired: string[] = [];

    const res = await appCalling(fired).request('/read', { headers: hdrs });

    expect(res.status).toBe(401);
    expect(fired).toEqual([]);
    expect(res.headers.get('X-Test-Verified')).toBeNull();
  });
});
