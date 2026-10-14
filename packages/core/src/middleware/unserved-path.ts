import type { MiddlewareHandler } from 'hono';
import { type RouteSource, servesRoute } from '../api-reference/document/registry.js';

/** The app's 404 for a path no route serves, ahead of every gate, for every caller. */
export function answerUnservedPath(app: () => RouteSource): MiddlewareHandler {
  return async (c, next) => {
    if (!servesRoute(app(), c.req.method, c.req.path)) return c.notFound();
    await next();
  };
}
