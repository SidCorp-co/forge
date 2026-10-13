import type { Env, Hono, MiddlewareHandler } from 'hono';
import { env } from '../lib/env.js';
import { loadWebBuild, type WebBuild } from './build.js';
import { withDemoCredential } from './demo-credential.js';
import type { AppFetch } from './gates.js';
import { webHost } from './host.js';

let served: WebBuild | null | undefined;

/**
 * The build WEB_DIST_DIR names, read once; null when this core serves no web. The server's boot
 * asks for it before it listens, so a core told to serve a build it cannot read never starts.
 */
export function servedWebBuild(): WebBuild | null {
  if (served === undefined) served = env.WEB_DIST_DIR ? loadWebBuild(env.WEB_DIST_DIR) : null;
  return served;
}

/**
 * Core hosts the web: the build WEB_DIST_DIR names is served ahead of every route, since a page
 * request for a path core also answers (`/guides`, `/pair`) is the web's; and a demo core answers a
 * request that carries no credential as its member. Called before any route is mounted, at import:
 * it reads no setting until a request arrives, so a test that sets the environment after importing
 * core is read as it set it.
 */
export function hostTheWeb<E extends Env>(app: Hono<E>): void {
  const fetch: AppFetch = (request) => Promise.resolve(app.fetch(request));
  let host: MiddlewareHandler | null | undefined;
  app.use('*', (c, next) => {
    if (host === undefined) {
      const build = servedWebBuild();
      host = build ? webHost(build, fetch) : null;
    }
    return host ? host(c, next) : next();
  });
  app.fetch = withDemoCredential(app.fetch);
}
