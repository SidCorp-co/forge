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
 * So every such route is sent a token with `beginPatRequest` replaced by a
 * sentinel, and a route that never reaches the sentinel is named — unless it
 * is one of the public routes listed below, which read no credential at all.
 */
import { readFileSync } from 'node:fs';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const SENTINEL = 418;

vi.mock('./pat-rest-surface.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pat-rest-surface.js')>()),
  beginPatRequest: async () => {
    throw new HTTPException(SENTINEL, {
      message: 'reached the PAT door',
      cause: { code: 'PAT_DOOR_SENTINEL' },
    });
  },
}));
vi.mock('../auth/device-credential.js', () => ({ verifyDeviceCredential: async () => null }));

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

/** Every path index.ts mounts a router or a handler at, longest first. */
function mounts(): string[] {
  const index = readFileSync('src/index.ts', 'utf8');
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
  return path
    .replace(/:[A-Za-z0-9_]+(\{[^}]*\})?\??/g, '00000000-0000-4000-8000-000000000000')
    .replace(/\*/g, 'x');
}

beforeAll(async () => {
  ({ app } = (await import('../index.js')) as unknown as { app: Hono });
  const seen = new Set<string>();
  routes = [];
  for (const r of app.routes) {
    if (r.method === 'ALL') continue;
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

describe('every grantable route admits a token', () => {
  it('lists as public only live routes that answer with no credential', async () => {
    for (const entry of PUBLIC_UNDER_MENU) {
      const [method = '', path = ''] = entry.split(' ');
      expect(routes, entry).toContainEqual({ method, path });
      const res = await app.request(concrete(path), { method });
      expect([401, 403, SENTINEL], entry).not.toContain(res.status);
    }
  });

  it('reaches the PAT door from every route under a menu prefix', async () => {
    const send = (r: Route, token: string | null) =>
      app.request(concrete(r.path), {
        method: r.method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'Content-Type': 'application/json',
        },
        ...(r.method === 'GET' || r.method === 'HEAD' ? {} : { body: '{}' }),
      });
    const shut: string[] = [];
    for (const r of routes) {
      if (patUngrantableFor(r.path, r.method) || !patPrefixForPath(r.path)) continue;
      const res = await send(r, `forge_pat_dev_${'a'.repeat(64)}`);
      if (res.status === SENTINEL) continue;
      if (PUBLIC_UNDER_MENU.includes(`${r.method} ${r.path}`)) continue;
      const body = (await res.text()).slice(0, 160);
      shut.push(
        `${r.method} ${r.path} answered ${res.status} ${body}, mounted at ${mountOf(r.path)}`,
      );
    }
    expect(
      shut,
      'these routes sit under a menu prefix but a token never reaches beginPatRequest there — ' +
        'give them a PAT-capable gate, or name them in PAT_UNGRANTABLE',
    ).toEqual([]);
  }, 120_000);
});
