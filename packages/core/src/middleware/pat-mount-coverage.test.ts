/**
 * ISS-1373 — every route the composed app serves is either grantable to a
 * personal or agent token or kept out by name, with its reason.
 *
 * Read off `app.routes` rather than a parse of `index.ts`, because a router
 * nested with `.route()` is invisible to a parse and is exactly where a route
 * slips past both lists.
 *
 * Being under a menu prefix is not the same as being grantable: a route there
 * behind a JWT-only or device-only gate lists a permission no token can use.
 * So each is sent a `*` token, with the real `beginPatRequest` admitting it,
 * and has to get through every handler ahead of its own to its own handler.
 *
 * Only what a gate reads is stood in for: the token row, the email check, the
 * admin list and the request body's validator pass; every database read
 * answers 418. A guard mounted ahead of the route cannot answer for it.
 */
import { readFileSync } from 'node:fs';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Device } from '../db/schema.js';
import type { PatPrincipal } from './require-pat.js';

const { PAST_THE_GATES, ZERO, TOKEN, DEVICE_TOKEN, probe } = vi.hoisted(() => {
  const state = { reached: 0, deepest: -1, chain: [] as { method: string; path: string }[] };
  return {
    PAST_THE_GATES: 418 as const,
    ZERO: '00000000-0000-4000-8000-000000000000',
    TOKEN: `forge_pat_dev_${'a'.repeat(64)}`,
    DEVICE_TOKEN: `forge_pat_dev_${'d'.repeat(64)}`,
    probe: {
      state,
      /** Which handler of the matched chain answered, read once the chain has unwound. */
      recordChain: (): MiddlewareHandler => async (c, next) => {
        await next();
        const { matchedRoutes } = await import('hono/route');
        state.deepest = c.req.routeIndex;
        state.chain = matchedRoutes(c).map((m) => ({ method: m.method, path: m.path }));
      },
    },
  };
});

/** Every read answers {@link PAST_THE_GATES}: a request that reads state got past every gate. */
function unreachableDatabase(): unknown {
  const read = () => {
    throw new HTTPException(PAST_THE_GATES, {
      message: 'reached the database',
      cause: { code: 'PAST_THE_GATES' },
    });
  };
  return new Proxy(read, {
    get: (_target, prop) => (prop === 'then' ? undefined : unreachableDatabase()),
    apply: read,
  });
}

function passThrough(): MiddlewareHandler {
  return async (_c, next) => next();
}

vi.mock('../db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/client.js')>()),
  db: unreachableDatabase(),
}));
vi.mock('./require-pat.js', async (importOriginal) => {
  const { PAT_GRANT_EPOCH } = await import('../auth/pat-permissions.js');
  return {
    ...(await importOriginal<typeof import('./require-pat.js')>()),
    authenticatePat: async (
      _c: unknown,
      token: string,
      _level: unknown,
      onVerified?: () => void,
    ): Promise<PatPrincipal | null> => {
      probe.state.reached += 1;
      if (token !== TOKEN && token !== DEVICE_TOKEN) return null;
      onVerified?.();
      return {
        kind: 'pat',
        agency: 'agent',
        agentUserId: null,
        userId: ZERO,
        tokenId: ZERO,
        scopes: ['read', 'write'],
        projectIds: null,
        boundProjectId: null,
        permissions: ['*'],
        grantEpoch: PAT_GRANT_EPOCH,
        deviceId: token === DEVICE_TOKEN ? ZERO : null,
      };
    },
  };
});
vi.mock('./auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth.js')>()),
  assertEmailVerified: passThrough,
}));
vi.mock('./require-admin.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./require-admin.js')>()),
  requireAdmin: passThrough,
}));
vi.mock('@hono/zod-validator', () => ({ zValidator: passThrough }));
vi.mock('./logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./logger.js')>()),
  requestLogger: probe.recordChain,
}));
vi.mock('../auth/device-credential.js', () => ({
  verifyDeviceCredential: async (token: unknown) =>
    token === DEVICE_TOKEN
      ? ({ id: ZERO, ownerId: ZERO, status: 'online' } as Partial<Device> as Device)
      : null,
}));

const { PAT_UNGRANTABLE, patPermissionPrefixes, patPrefixForPath, patUngrantableFor } =
  await import('../auth/pat-permissions.js');

type Route = { method: string; path: string };

/**
 * Public lookups by the invitation's own token, beside token-gated siblings
 * (`/pending`, `/:token/accept`) under the same prefix, so no path exclusion
 * can name them without shutting the siblings too.
 */
const PUBLIC_UNDER_MENU = ['GET /api/invitations/:token', 'GET /api/org-invitations/:token'];

let app: Hono;
let routes: Route[];
let catchAlls: Map<string, number>;

function indexSource(): string {
  return readFileSync('src/index.ts', 'utf8');
}

/** Every path index.ts mounts a router or a handler at, longest first. */
function mounts(): string[] {
  const index = indexSource();
  const found = [
    ...index.matchAll(/app\.route\(\s*'([^']+)'/g),
    ...index.matchAll(/app\.(?:get|on|use)\(\s*(?:\[[^\]]*\]\s*,\s*)?'([^']+)'/g),
  ].map((m) => m[1] ?? '');
  return [...new Set(found)].sort((a, b) => b.length - a.length);
}

function mountOf(path: string): string {
  const hit = mounts().find(
    (at) => at === '/' || path === at || path.startsWith(`${at.replace(/\/$/, '')}/`),
  );
  return hit ? `'${hit}'` : 'no mount in index.ts';
}

function concrete(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?\??/g, ZERO).replace(/\*/g, 'x');
}

async function send(on: Hono, r: Route, token: string | null) {
  probe.state.reached = 0;
  probe.state.deepest = -1;
  probe.state.chain = [];
  const res = await on.request(concrete(r.path), {
    method: r.method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    ...(r.method === 'GET' || r.method === 'HEAD' ? {} : { body: '{}' }),
  });
  return { status: res.status, body: (await res.text()).slice(0, 160) };
}

const REFUSED = [401, 403];

/** A gate that does not recognise a credential answers 401; a 403 is a decision about one it did. */
const UNRECOGNISED = 401;

/**
 * Why a `*` token does not get through to this route's own handler, or null
 * where it does. A 403 there is the route deciding about a caller it
 * authenticated, which is not this test's question.
 */
async function shutTo(on: Hono, r: Route): Promise<string | null> {
  const res = await send(on, r, TOKEN);
  const { reached, deepest, chain } = probe.state;
  let own = -1;
  chain.forEach((step, i) => {
    if (step.method === r.method && step.path === r.path) own = i;
  });
  const answered = `answered ${res.status} ${res.body}`;
  if (reached === 0) return `${answered} without reaching the PAT door`;
  if (own === -1 || deepest < own) {
    const at = chain[deepest];
    return `${answered} at ${at?.method} ${at?.path}, ahead of its own handler`;
  }
  return res.status === UNRECOGNISED ? `${answered} past the PAT door` : null;
}

function doorOf(r: Route) {
  return patUngrantableFor(r.path, r.method)?.admits;
}

beforeAll(async () => {
  ({ app } = (await import('../index.js')) as unknown as { app: Hono });
  const seen = new Set<string>();
  routes = [];
  catchAlls = new Map();
  for (const r of app.routes) {
    if (r.method === 'ALL') {
      catchAlls.set(r.path, (catchAlls.get(r.path) ?? 0) + 1);
      continue;
    }
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ method: r.method, path: r.path });
  }
}, 120_000);

describe('every route is in the grant grammar or named out of it', () => {
  it('reads a composed app, not an empty one', () => {
    expect(routes.length).toBeGreaterThan(500);
  });

  it('leaves no route under neither list', () => {
    const neither = routes
      .filter((r) => !patUngrantableFor(r.path, r.method) && !patPrefixForPath(r.path))
      .map((r) => `${r.method} ${r.path}, mounted at ${mountOf(r.path)}`);
    expect(
      neither,
      'these routes are in neither PAT_PERMISSION_RESOURCES nor PAT_UNGRANTABLE ' +
        '(auth/pat-permissions.ts): give each a permission, or name why it is kept out',
    ).toEqual([]);
  });

  it('gives every exclusion a reason', () => {
    const bare = Object.entries(PAT_UNGRANTABLE).filter(([, why]) => why.reason.trim() === '');
    expect(bare.map(([p]) => p)).toEqual([]);
  });

  it('holds no exclusion that matches no live route', () => {
    const stale = Object.keys(PAT_UNGRANTABLE).filter(
      (pattern) => !routes.some((r) => patUngrantableFor(r.path, r.method)?.pattern === pattern),
    );
    expect(stale, 'delete these rather than leave a standing exclusion').toEqual([]);
  });

  it('holds no menu prefix that matches no live route', () => {
    const empty = patPermissionPrefixes().filter(
      (prefix) =>
        !routes.some(
          (r) =>
            !patUngrantableFor(r.path, r.method) && patPrefixForPath(r.path)?.prefix === prefix,
        ),
    );
    expect(empty, 'a permission covering these would grant nothing').toEqual([]);
  });
});

describe('no router guards the routes mounted after it', () => {
  it('runs no middleware over every path, or every /api path, but what index.ts registers itself', () => {
    const own = new Map<string, number>();
    for (const m of indexSource().matchAll(/app\.use\(\s*'(\*|\/api\/\*)'/g)) {
      const at = m[1] === '*' ? '/*' : '/api/*';
      own.set(at, (own.get(at) ?? 0) + 1);
    }
    const leaked = ['/*', '/api/*']
      .filter((at) => (catchAlls.get(at) ?? 0) !== (own.get(at) ?? 0))
      .map(
        (at) =>
          `${catchAlls.get(at) ?? 0} middleware run over ${at}, and index.ts registers ` +
          `${own.get(at) ?? 0} there itself`,
      );
    expect(
      leaked,
      "a router mounted at '/' or '/api' with use('*') runs ahead of every route mounted " +
        'after it, whatever that route admits: put its guard on its own routes instead',
    ).toEqual([]);
  });
});

describe('the probe names a route a token cannot get through to', () => {
  async function planted() {
    const { Hono } = await import('hono');
    const { authUserRow, requireAuth } = await import('./auth.js');
    const { requireDevice } = await import('./require-device.js');
    const jwtOnly = (c: Context) =>
      (c.req.header('Authorization') ?? '').startsWith('Bearer eyJ')
        ? c.json({})
        : c.json({ error: 'jwt only' }, 401);
    const readsState: MiddlewareHandler = async (c, next) => {
      await authUserRow(c, ZERO);
      await next();
    };
    const on = new Hono();
    on.use('*', probe.recordChain());
    on.get('/api/runners/jwt-only', jwtOnly);
    on.use('/api/runners/*', requireAuth());
    on.get('/api/runners/behind-a-guard', jwtOnly);
    on.get('/api/runners/after-a-read', requireAuth(), readsState, requireDevice(), (c) =>
      c.json({}),
    );
    on.get('/api/runners/fine', requireAuth(), (c) => c.json({}));
    return on;
  }

  it.each([
    ['/api/runners/jwt-only', 'without reaching the PAT door'],
    ['/api/runners/behind-a-guard', 'past the PAT door'],
    ['/api/runners/after-a-read', 'ahead of its own handler'],
  ])('%s', async (path, why) => {
    expect(await shutTo(await planted(), { method: 'GET', path })).toContain(why);
  });

  it('passes a route whose own gate admits the token', async () => {
    expect(await shutTo(await planted(), { method: 'GET', path: '/api/runners/fine' })).toBeNull();
  });
});

describe('every door a route declares admits what it names', () => {
  it('lists as public only live routes that answer with no credential', async () => {
    for (const entry of PUBLIC_UNDER_MENU) {
      const [method = '', path = ''] = entry.split(' ');
      expect(routes, entry).toContainEqual({ method, path });
      const res = await send(app, { method, path }, null);
      expect(REFUSED, `${entry} answered ${res.status} ${res.body}`).not.toContain(res.status);
    }
  });

  it('gets a token through to the handler of every route under a menu prefix', async () => {
    const shut: string[] = [];
    for (const r of routes) {
      if (patUngrantableFor(r.path, r.method) || !patPrefixForPath(r.path)) continue;
      if (PUBLIC_UNDER_MENU.includes(`${r.method} ${r.path}`)) continue;
      const why = await shutTo(app, r);
      if (why) shut.push(`${r.method} ${r.path} ${why}, mounted at ${mountOf(r.path)}`);
    }
    expect(
      shut,
      'these routes sit under a menu prefix and a token does not get through to them — ' +
        'give them a PAT-capable gate, or name them in PAT_UNGRANTABLE',
    ).toEqual([]);
  }, 120_000);

  it('answers every public exclusion with no credential at all', async () => {
    const shut: string[] = [];
    for (const r of routes) {
      if (doorOf(r) !== 'public') continue;
      const res = await send(app, r, null);
      if (!REFUSED.includes(res.status)) continue;
      shut.push(`${r.method} ${r.path} answered ${res.status}: ${res.body}`);
    }
    expect(
      shut,
      'PAT_UNGRANTABLE tells a token holder to send these with no credential, and they refuse ' +
        'one that does — make the route public, or name the door it really admits',
    ).toEqual([]);
  }, 120_000);

  it('admits a device credential on every device exclusion', async () => {
    const shut: string[] = [];
    for (const r of routes) {
      if (doorOf(r) !== 'device') continue;
      const res = await send(app, r, DEVICE_TOKEN);
      if (!REFUSED.includes(res.status)) continue;
      shut.push(`${r.method} ${r.path} answered ${res.status}: ${res.body}`);
    }
    expect(
      shut,
      'PAT_UNGRANTABLE tells a token holder to call these from the box, and they refuse the ' +
        "box's own credential — fix the route's gate, or name the door it really admits",
    ).toEqual([]);
  }, 120_000);
});
