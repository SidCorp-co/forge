import type { MiddlewareHandler } from 'hono';
import { type RouteSource, servesRoute } from '../api-reference/document/registry.js';

/**
 * Answers a request for a path no route serves with the app's own 404, ahead of every gate.
 *
 * A router-wide guard runs before routing can find that nothing is there, so without this a caller
 * with no token is told 401, a token is told its credential is wrong (`PAT_NOT_PERMITTED`,
 * `PAT_ACCOUNT_ROUTE`) and a session is told it is not an admin, each about a path that is not
 * there. Which paths are served is read off the composed app's route table at each request, the
 * table the API reference is built from, so no list of paths is kept here and a route mounted later
 * is served without a change here.
 *
 * The answer is the same for every caller, the one with no credential included: the route table is
 * public already, in `/api/openapi.json`, which needs no credential, so a 404 here tells nobody
 * which paths exist.
 */
export function answerUnservedPath(app: () => RouteSource): MiddlewareHandler {
  return async (c, next) => {
    if (!servesRoute(app(), c.req.method, c.req.path)) return c.notFound();
    await next();
  };
}
