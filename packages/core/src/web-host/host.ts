import { matchesRoute } from '@forge/contracts/web-host';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Context, MiddlewareHandler } from 'hono';
import { compress } from 'hono/compress';
import pkg from '../../package.json' with { type: 'json' };
import { env } from '../lib/env.js';
import type { WebBuild } from './build.js';
import { type AppFetch, type GateAnswer, guidesGate, operatorGate, redirectTo } from './gates.js';

/** A hashed asset never changes under its name; every other file of the build may. */
const ASSET_CACHE = 'public, max-age=31536000, immutable';
const FILE_CACHE = 'public, max-age=3600';

/** Paths that are core's own and never a page, whatever the request accepts. */
const CORE_ONLY = /^\/(api|ws|mcp)(\/|$)/;

const FORGE_CONFIG = new Set(['/forge-config', '/.well-known/forge-config.json']);

/** The origin the reader addressed: the proxy's forwarded scheme over the one it spoke to core. */
function publicOrigin(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  if (proto === 'https' || proto === 'http') url.protocol = `${proto}:`;
  return url.origin;
}

/** A file name in the last segment (`/guides/<slug>.md`, `/install.sh`) is a file, never a page. */
const NAMES_A_FILE = /\.[A-Za-z0-9]+$/;

const isPageRequest = (c: Context, rel: string): boolean =>
  !NAMES_A_FILE.test(rel) && (c.req.header('accept')?.includes('text/html') ?? false);

/**
 * Core serves the web (the packages/web-v2 build): its files, `/forge-config` for a client finding
 * this instance, and its page for every route the web declares, after the checks a page request
 * answers before the page loads. Anything else falls through to core's own routes.
 */
export function webHost(build: WebBuild, fetch: AppFetch): MiddlewareHandler {
  const base = build.basePath;
  const serve = serveStatic({
    root: build.dir,
    rewriteRequestPath: (path) => path.slice(base.length),
  });
  // set on the response serveStatic hands back: a header its onFound sets lands after the body is made
  const file = async (c: Context, next: () => Promise<void>, rel: string) => {
    const res = await serve(c, next);
    res?.headers.set('Cache-Control', rel.startsWith('/assets/') ? ASSET_CACHE : FILE_CACHE);
    return res ?? undefined;
  };

  // gzip on the way out, as the web's own server did: the build's scripts are most of a first load
  const squeeze = compress();
  const squeezed = async (c: Context, produce: () => Promise<Response | undefined>) => {
    await squeeze(c, async () => {
      const res = await produce();
      if (res) c.res = res;
    });
    return c.res;
  };

  const page = (status: 200 | 404, rel: string): Response =>
    new Response(build.indexHtml, {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // a share link's token is in the path: no referrer carries it on, and no cache or index keeps it
        ...(rel.startsWith('/s/')
          ? {
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
              'x-robots-tag': 'noindex, nofollow',
            }
          : { 'cache-control': 'no-cache' }),
      },
    });

  const gate = async (c: Context, rel: string, url: URL): Promise<GateAnswer> => {
    if (rel === '/guides' || rel.startsWith('/guides/'))
      return guidesGate(rel, url, publicOrigin(c), build);
    if (rel === '/admin' || rel.startsWith('/admin/')) {
      return operatorGate(c.req.header('cookie'), url, fetch, base);
    }
    // a demo core signs every request in as its member (demo-credential.ts), so sign-in is only
    // shown after a sign-out, which lands here with session=ended
    if (env.FORGE_DEMO_MODE && rel === '/login' && url.searchParams.get('session') !== 'ended') {
      return redirectTo(`${base}/`);
    }
    return null;
  };

  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const path = c.req.path;
    if (base && path !== base && !path.startsWith(`${base}/`)) return next();
    const rel = path.slice(base.length) || '/';
    if (CORE_ONLY.test(rel)) return next();

    if (FORGE_CONFIG.has(rel)) {
      return c.json(
        { apiUrl: publicOrigin(c), version: pkg.version },
        200,
        // 60s is long enough to cut chatter, short enough that a moved instance strands no client
        { 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' },
      );
    }
    if (build.files.has(rel)) return squeezed(c, () => file(c, next, rel));
    if (!isPageRequest(c, rel)) return next();

    if (!build.manifest.routes.some((route) => matchesRoute(route, rel))) {
      // a path the web declares no route for is core's to answer; what it does not answer either
      // is the web's not-found page, with the status that says so
      await next();
      if (c.res.status === 404) return squeezed(c, async () => page(404, rel));
      return;
    }
    const url = new URL(c.req.url);
    return (await gate(c, rel, url)) ?? squeezed(c, async () => page(200, rel));
  };
}
