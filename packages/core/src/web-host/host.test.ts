// Core serving the web build (host.ts): its files and their caching, the page for every route the
// web declares, a real 404 for a path nothing answers, `/forge-config`, a share link's headers, and
// the checks a page request answers before the page loads (gates.ts): guides, /admin, demo sign-in.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ FORGE_DEMO_MODE: false }));
vi.mock('../lib/env.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/env.js')>();
  return {
    ...real,
    env: new Proxy(real.env, {
      get: (target, key) =>
        key in settings ? settings[key as keyof typeof settings] : Reflect.get(target, key),
    }),
  };
});

import pkg from '../../package.json' with { type: 'json' };
import { loadWebBuild } from './build.js';
import { webHost } from './host.js';

const INDEX = '<!doctype html><html><body><div id="root"></div></body></html>';
// past compress()'s 1 KiB floor, so the gzip the web's own server gave a script is observable
const SCRIPT = `console.log(${JSON.stringify('x'.repeat(4096))});`;
const ROUTES = [
  '/',
  '/login/',
  '/admin',
  '/admin/fleet/',
  '/guides/',
  '/guides/$slug/',
  '/projects/$slug/',
  '/projects/$slug/issues/$id/',
  '/s/$token/',
];

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A web build as `vite build` lays one out, served under `basePath`. */
function buildDir(basePath = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-web-host-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), INDEX);
  writeFileSync(join(dir, 'assets', 'index-3b_mgYcl.js'), SCRIPT);
  writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(
    join(dir, 'web-host.json'),
    JSON.stringify({ basePath, routes: ROUTES, helpSlugs: ['getting-started'] }),
  );
  return dir;
}

interface Whoami {
  status: number;
  body: unknown;
}

/** Core with the web in front, a whoami that answers what a test sets, and one route of core's own (`/pair`). */
function core(basePath = '') {
  const seen: (string | null)[] = [];
  const whoami: { answer: (cookie: string | null) => Whoami } = {
    answer: () => ({ status: 200, body: { isAdmin: true } }),
  };
  const app = new Hono();
  app.use(
    '*',
    webHost(loadWebBuild(buildDir(basePath)), (request) => Promise.resolve(app.fetch(request))),
  );
  app.get('/api/admin/whoami', (c) => {
    const cookie = c.req.header('cookie') ?? null;
    seen.push(cookie);
    const { status, body } = whoami.answer(cookie);
    return c.json(body, status as 200);
  });
  app.get('/pair', (c) => c.text('core pairing page'));
  const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    app.request(path, { method, headers: { accept: 'text/html,*/*', ...headers } });
  return { app, get, seen, whoami };
}

beforeEach(() => {
  settings.FORGE_DEMO_MODE = false;
});

describe('the build files', () => {
  it('serves a hashed asset for a year, immutable, gzipped when the reader takes gzip', async () => {
    const { get } = core();
    const res = await get('/assets/index-3b_mgYcl.js', {
      accept: '*/*',
      'accept-encoding': 'gzip',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(res.headers.get('content-encoding')).toBe('gzip');
  });

  it('serves the asset as written to a reader that takes no encoding', async () => {
    const res = await core().get('/assets/index-3b_mgYcl.js', { accept: '*/*' });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toBe(SCRIPT);
  });

  it('keeps a file without a hash in its name for an hour only', async () => {
    const res = await core().get('/favicon.svg', { accept: '*/*' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('never serves the manifest as a file', async () => {
    const res = await core().get('/web-host.json', { accept: '*/*' });
    expect(res.status).toBe(404);
  });
});

describe('the page', () => {
  it('is served for every route the web declares, params and nesting included, and is revalidated', async () => {
    const { get } = core();
    for (const path of ['/', '/login', '/projects/hop', '/projects/hop/issues/ISS-7']) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.text()).toBe(INDEX);
    }
  });

  it('answers HEAD as it answers GET', async () => {
    const res = await core().get('/projects/hop', {}, 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it("is the web's not-found page with a real 404 for a path neither the web nor core answers", async () => {
    const res = await core().get('/projects/hop/no/such/page/here');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(INDEX);
  });

  it('leaves to core a path core answers and the web declares no route for', async () => {
    const res = await core().get('/pair');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('core pairing page');
  });

  it('leaves to core what is not a page request: an API path, a file name, a write, a reader that takes no HTML', async () => {
    const { get } = core();
    expect((await get('/api/projects')).status).toBe(404);
    expect(await (await get('/api/projects')).text()).not.toBe(INDEX);
    expect(await (await get('/guides/getting-started.md')).text()).not.toBe(INDEX);
    expect(await (await get('/projects/hop', {}, 'POST')).text()).not.toBe(INDEX);
    expect(await (await get('/projects/hop', { accept: 'application/json' })).text()).not.toBe(
      INDEX,
    );
  });

  it('keeps a share link out of every cache, referrer and index', async () => {
    const res = await core().get('/s/tok_abc123');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });
});

describe('/forge-config', () => {
  it('names this instance at the origin the reader addressed, for a minute, to any origin', async () => {
    const { get } = core();
    for (const path of ['/forge-config', '/.well-known/forge-config.json']) {
      const res = await get(path, { accept: 'application/json', 'x-forwarded-proto': 'https' });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=60');
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(await res.json()).toEqual({ apiUrl: 'https://localhost', version: pkg.version });
    }
  });
});

describe('a build made for a base path', () => {
  it('is served under the path its manifest names, and nowhere else', async () => {
    const { get } = core('/forge');
    expect((await get('/forge/assets/index-3b_mgYcl.js', { accept: '*/*' })).status).toBe(200);
    const page = await get('/forge/projects/hop');
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(INDEX);
    expect(await (await get('/projects/hop')).text()).not.toBe(INDEX);
    expect((await get('/forge/forge-config', { accept: 'application/json' })).status).toBe(200);
  });

  it('sends an ended /admin session to sign in under the same base path', async () => {
    const { get, whoami } = core('/forge');
    whoami.answer = () => ({ status: 401, body: { code: 'SESSION_EXPIRED' } });
    const res = await get('/forge/admin', { cookie: 'forge_auth=old' });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('/forge/login?session=ended');
  });
});

describe('a guide address', () => {
  it('naming no guide is a 404 document saying so, before the web loads', async () => {
    const res = await core().get('/guides/no-such-guide');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('Forge publishes no guide called “no-such-guide”');
  });

  it('naming a help page or a door the web does not carry is a 404 document', async () => {
    const { get } = core();
    expect((await get('/guides?path=not-a-help-page')).status).toBe(404);
    expect((await get('/guides?for=nobody')).status).toBe(404);
  });

  it('naming a guide, a help page the web carries, or the index is the page', async () => {
    const { get } = core();
    for (const path of ['/guides/issue-dependencies', '/guides?path=getting-started', '/guides']) {
      expect((await get(path)).status, path).toBe(200);
    }
  });
});

describe('the /admin gate', () => {
  const JUNK = 'junk-parent-domain-value';
  const VALID = 'valid-host-value';
  /** A core that opens a session only for VALID, trying every forge_auth value in order. */
  const onlyValid = (cookie: string | null): Whoami =>
    (cookie ?? '').split(';').some((pair) => pair.trim() === `forge_auth=${VALID}`)
      ? { status: 200, body: { isAdmin: true } }
      : { status: 401, body: { code: 'SESSION_EXPIRED' } };

  it('hands core every forge_auth value, in order, and serves the console when one opens a session', async () => {
    const { get, seen, whoami } = core();
    whoami.answer = onlyValid;
    const res = await get('/admin', {
      cookie: `theme=dark; forge_auth=${JUNK}; forge_auth=${VALID}`,
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([`forge_auth=${JUNK}; forge_auth=${VALID}`]);
  });

  it('sends a session core no longer honours to sign in again, marked as ended', async () => {
    const { get, whoami } = core();
    whoami.answer = onlyValid;
    const res = await get('/admin/fleet', { cookie: `forge_auth=${JUNK}` });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('/login?session=ended');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('serves the console for the browser to ask core when the request carries no forge_auth', async () => {
    const { get, seen } = core();
    const res = await get('/admin', { cookie: 'theme=dark; forge_auth=' });
    expect(res.status).toBe(200);
    expect(seen).toEqual([]);
  });

  it('sends a member who is not an operator home', async () => {
    const { get, whoami } = core();
    whoami.answer = () => ({ status: 200, body: { isAdmin: false } });
    const res = await get('/admin', { cookie: `forge_auth=${VALID}` });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('/');
  });

  it('leaves an unverified address to the console, which says so, and sends any other refusal home', async () => {
    const { get, whoami } = core();
    whoami.answer = () => ({ status: 403, body: { code: 'EMAIL_NOT_VERIFIED' } });
    expect((await get('/admin', { cookie: `forge_auth=${VALID}` })).status).toBe(200);
    whoami.answer = () => ({ status: 403, body: { code: 'FORBIDDEN' } });
    expect((await get('/admin', { cookie: `forge_auth=${VALID}` })).headers.get('location')).toBe(
      '/',
    );
  });
});

describe('sign-in on a demo core', () => {
  it('sends the browser home, never to an API route, since every request is signed in as the demo member', async () => {
    settings.FORGE_DEMO_MODE = true;
    const res = await core().get('/login');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('/');
  });

  it('shows the form after a sign-out, so it is not signed straight back in', async () => {
    settings.FORGE_DEMO_MODE = true;
    expect((await core().get('/login?session=ended')).status).toBe(200);
  });

  it('is the ordinary sign-in on any other core', async () => {
    expect((await core().get('/login')).status).toBe(200);
  });
});
