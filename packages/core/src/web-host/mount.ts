import type { Env, Hono } from 'hono';
import { env } from '../lib/env.js';
import { loadWebBuild } from './build.js';
import { withDemoCredential } from './demo-credential.js';
import { webHost } from './host.js';

/**
 * Core hosts the web: the build WEB_DIST_DIR names is served ahead of every route, since a page
 * request for a path core also answers (`/guides`, `/pair`) is the web's; and a demo core answers a
 * request that carries no credential as its member. Called before any route is mounted.
 */
export function hostTheWeb<E extends Env>(app: Hono<E>): void {
  if (env.WEB_DIST_DIR) {
    const build = loadWebBuild(env.WEB_DIST_DIR);
    app.use(
      '*',
      webHost(build, (request) => Promise.resolve(app.fetch(request))),
    );
  }
  app.fetch = withDemoCredential(app.fetch);
}
