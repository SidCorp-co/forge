/**
 * ISS-974 — the route tells the caller which permission it wanted.
 *
 * Driven through a real Hono app and the real `errorHandler`, and asserted on
 * `res.headers.get(...)`, because the thing under test is what reaches the
 * wire: a header prepared before a thrown `HTTPException` has to survive the
 * error path, and a fake context's call log cannot tell you whether it did.
 *
 * The two failures worth naming. A header only on the 403 leaves
 * discovery-by-trial intact, which is the whole defect. And a header derived
 * anywhere but from the fence's own decision passes every assertion about its
 * presence while being able to name a permission that would not admit the
 * request — so the last block here counts resolutions rather than values.
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../mcp/tools/project-scope.js', () => ({ patEffectiveProjectIds: () => null }));

const authenticatePat = vi.fn();
vi.mock('./require-pat.js', () => ({
  authenticatePat: (...a: unknown[]) => authenticatePat(...a),
}));

const verifyUserToken = vi.fn();
vi.mock('../auth/jwt.js', () => ({
  verifyUserToken: (...a: unknown[]) => verifyUserToken(...a),
}));

// cm:guard `patPermissionWanted` is spied rather than replaced: the default delegates to the real one, so every value assertion below is against the real declaration and only the last block changes what it answers. A stub-by-default here would turn the whole file into a test of its own fixture.
const permissionWanted = vi.fn();
vi.mock('../auth/pat-permissions.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../auth/pat-permissions.js')>();
  return {
    ...real,
    patPermissionWanted: (...a: Parameters<typeof real.patPermissionWanted>) =>
      permissionWanted(...a),
  };
});

const { errorHandler } = await import('./error.js');
const { requireAuth } = await import('./auth.js');
const { PAT_ACCEPTED_PERMISSIONS_HEADER } = await import('./pat-rest-surface.js');
const realPermissions = await vi.importActual<typeof import('../auth/pat-permissions.js')>(
  '../auth/pat-permissions.js',
);

const HEADER = PAT_ACCEPTED_PERMISSIONS_HEADER;
const PAT = `forge_pat_dev_${'a'.repeat(64)}`;
const JWT = 'not-a-pat-token';

function principal(permissions: readonly string[] | null, scopes = ['read', 'write']) {
  return {
    kind: 'pat',
    agency: 'human',
    userId: 'u1',
    tokenId: 't1',
    scopes,
    permissions,
    projectIds: null,
    boundProjectId: null,
    deviceId: null,
  };
}

/**
 * One router per mount, each self-gating, the way `index.ts` mounts them.
 *
 * `/api/projects` is served by two of them on purpose: Hono runs the
 * middleware of EVERY router whose prefix matches, so this is the shape that
 * would emit the header more than once if it were set per router.
 */
function makeApp() {
  const app = new Hono();
  for (const mount of ['/api/issues', '/api/schedules', '/api/pat', '/api/me']) {
    const r = new Hono();
    r.use('*', requireAuth());
    r.all('/*', (c) => c.json({ ok: true }));
    r.all('/', (c) => c.json({ ok: true }));
    app.route(mount, r);
  }
  for (const _copy of [1, 2]) {
    const r = new Hono();
    r.use('*', requireAuth());
    r.all('/*', (c) => c.json({ ok: true }));
    app.route('/api/projects', r);
  }
  app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
  return app;
}

async function send(path: string, opts: { method?: string; token?: string } = {}) {
  const res = await makeApp().request(path, {
    method: opts.method ?? 'GET',
    headers: { Authorization: `Bearer ${opts.token ?? PAT}` },
  });
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: res.status, header: res.headers.get(HEADER), raw: res, body };
}

/** The permission the refusal body names, or undefined where it names none. */
function wantedOf(body: Record<string, unknown> | null): string | undefined {
  const details = body?.details as { wanted?: string } | undefined;
  return details?.wanted;
}

// cm:guard these four mirror the ONE contract `authenticatePat` offers about `onVerified`: it fires the instant `verifyPat` resolves a row, and never otherwise. A mock that fires it unconditionally would make the last case below — a throttle above verification — pass while the fence leaked (ISS-974), so the callback is invoked here only where the real function would invoke it.
function verifiesAs(p: ReturnType<typeof principal>) {
  authenticatePat.mockImplementation(async (_c, _t, _l, onVerified?: () => void) => {
    onVerified?.();
    return p;
  });
}

function doesNotVerify() {
  authenticatePat.mockImplementation(async () => null);
}

function throttles(afterVerifying: boolean) {
  authenticatePat.mockImplementation(async (_c, _t, _l, onVerified?: () => void) => {
    if (afterVerifying) onVerified?.();
    throw new HTTPException(429, {
      message: 'rate limit exceeded',
      cause: { code: 'RATE_LIMITED' },
    });
  });
}

beforeEach(() => {
  authenticatePat.mockReset();
  verifyUserToken.mockReset();
  permissionWanted.mockReset();
  permissionWanted.mockImplementation(realPermissions.patPermissionWanted);
});

describe('a success is told what admitted it, not only a refusal', () => {
  it('carries the header on a 200', async () => {
    verifiesAs(principal(null));
    const res = await send('/api/issues');
    expect(res.status).toBe(200);
    expect(res.header).toBe('issues:read');
  });

  it('names the write level on a write method, on the same resource', async () => {
    verifiesAs(principal(null));
    const res = await send('/api/issues', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.header).toBe('issues:write');
  });

  // cm:guard `/api/schedules` is the one path here whose resource can be MOVED without changing the union, so this is the assertion that goes red when `PAT_PERMISSION_RESOURCES` reassigns it — which is what says the header follows the fence's own declaration rather than a table of its own (ISS-974).
  it('names the resource the declaration gives the path, not the one the path looks like', async () => {
    verifiesAs(principal(null));
    const res = await send('/api/schedules');
    expect(res.status).toBe(200);
    expect(res.header).toBe('schedules:read');
  });

  it('carries exactly one value through a path two routers match', async () => {
    verifiesAs(principal(null));
    const res = await send('/api/projects/p1/issues');
    expect(res.status).toBe(200);
    expect(res.header).toBe('projects:read');
    expect(String(res.header)).not.toContain(',');
  });
});

describe('every refusal that knows the answer says it', () => {
  it('says it on PAT_PERMISSION_REQUIRED, and the body cannot disagree', async () => {
    verifiesAs(principal(['issues:read']));
    const res = await send('/api/schedules');
    expect(res.status).toBe(403);
    expect(res.body?.code).toBe('PAT_PERMISSION_REQUIRED');
    expect(res.header).toBe('schedules:read');
    expect(wantedOf(res.body)).toBe(res.header);
  });

  it('says it on INSUFFICIENT_SCOPE', async () => {
    verifiesAs(principal(null, ['read']));
    const res = await send('/api/issues', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(res.body?.code).toBe('INSUFFICIENT_SCOPE');
    expect(res.header).toBe('issues:write');
  });
});

// cm:guard ABSENT, never empty-valued: an empty header on these paths reads as "this route requires nothing" on exactly the routes a PAT may never reach, which is a worse answer than silence. `toBeNull` is the assertion, and `toBe('')` would pass a `wanted ?? ''` that ships the opposite claim (ISS-974).
describe('a path no permission covers carries no header at all', () => {
  it.each(['/api/pat', '/api/me/ops-health'])('%s is refused with no header', async (path) => {
    verifiesAs(principal(null));
    const res = await send(path);
    expect(res.status).toBe(403);
    expect(res.body?.code).toBe('PAT_NOT_PERMITTED');
    expect(res.header).toBeNull();
  });

  it('is silent rather than empty even for a token that holds everything', async () => {
    verifiesAs(principal(['issues:read', 'issues:write']));
    const res = await send('/api/pat');
    expect(res.header).toBeNull();
    expect(res.raw.headers.has(HEADER)).toBe(false);
  });
});

describe('the header belongs to the PAT fence and to nothing else', () => {
  it('a user JWT is answered without it, because no permission was consulted', async () => {
    verifyUserToken.mockResolvedValue({ sub: 'u1' });
    const res = await send('/api/issues', { token: JWT });
    expect(res.status).toBe(200);
    expect(res.header).toBeNull();
    expect(authenticatePat).not.toHaveBeenCalled();
  });

  // cm:guard the line is AUTHENTICATION, never the status code, and these three are what hold it there. The middle case and the last one are the SAME 429 to a reader of the response: only whether `verifyPat` resolved separates them, which is why the callback and not the status decides (ISS-974). Read the status-based version of this — `refusal.status === 429` — as the shape that passes the middle case and leaks on the last.
  it('a throttled token that DID verify is still told what the route wanted', async () => {
    throttles(true);
    const res = await send('/api/issues');
    expect(res.status).toBe(429);
    expect(res.header).toBe('issues:read');
  });

  it('a 429 thrown BEFORE verification tells nothing, whatever its status says', async () => {
    throttles(false);
    const res = await send('/api/issues');
    expect(res.status).toBe(429);
    expect(res.header).toBeNull();
  });

  it('an unverifiable token is told nothing, so the 401 leaks no map of the fence', async () => {
    doesNotVerify();
    const res = await send('/api/issues');
    expect(res.status).toBe(401);
    expect(res.header).toBeNull();
  });
});

/**
 * The property the value assertions above cannot reach.
 *
 * They would all pass with the header and the fence resolving the path
 * separately, because two calls to a deterministic resolver agree. So these
 * count the calls and then make the resolver disagree with itself.
 */
describe('one resolution per request, handed to every consumer', () => {
  it('resolves the permission exactly once on a request that reaches the grant check', async () => {
    verifiesAs(principal(['issues:read']));
    const res = await send('/api/issues');
    expect(res.status).toBe(200);
    expect(permissionWanted).toHaveBeenCalledTimes(1);
    expect(permissionWanted).toHaveBeenCalledWith('/api/issues', 'read');
  });

  it('resolves once on a refusal too, so the body and the header share one value', async () => {
    verifiesAs(principal(['issues:read']));
    await send('/api/schedules');
    expect(permissionWanted).toHaveBeenCalledTimes(1);
  });

  // cm:guard the resolver answers `schedules:read` first and `issues:read` after, so a second resolution on the request path admits the request while the header names what was refused — or refuses while the header names what was allowed, depending which consumer calls first. Either way the two disagree, which is the failure no assertion about the header's VALUE can see (ISS-974).
  it('cannot let the header and the decision disagree when the resolver changes its mind', async () => {
    verifiesAs(principal(['issues:read']));
    permissionWanted
      .mockReturnValueOnce('schedules:read')
      .mockReturnValueOnce('issues:read')
      .mockReturnValue('issues:read');
    const res = await send('/api/schedules');
    expect(res.status).toBe(403);
    expect(res.header).toBe('schedules:read');
    expect(wantedOf(res.body)).toBe('schedules:read');
  });
});
