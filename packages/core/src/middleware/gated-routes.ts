// A router's gate over its own routes alone (ISS-925). Every project router is mounted at
// `/api/projects`, so a `use('*', gate)` on one runs on every `/api/projects/*` request that reaches
// it, its siblings' included, and 401s an unauthenticated route of another router by order of mount.
// A router made here runs `gates` first in each route it registers, on that method and path only.

import { type Env, Hono, type MiddlewareHandler } from 'hono';

const METHODS = ['get', 'post', 'put', 'delete', 'options', 'patch', 'all'] as const;

type Register = (...args: unknown[]) => unknown;

/** A Hono router whose every route, registered by method or by `on`, runs `gates` before its own handlers. */
export function gatedRoutes<E extends Env>(...gates: MiddlewareHandler<E>[]): Hono<E> {
  const router = new Hono<E>();
  const slots = router as unknown as Record<string, Register>;
  for (const method of METHODS) {
    const register = slots[method] as Register;
    // `get(path, ...handlers)`, or `get(...handlers)` on the path the chain last named
    slots[method] = (first: unknown, ...rest: unknown[]) =>
      typeof first === 'string'
        ? register(first, ...gates, ...rest)
        : register(...gates, first, ...rest);
  }
  const on = slots.on as Register;
  slots.on = (method: unknown, path: unknown, ...handlers: unknown[]) =>
    on(method, path, ...gates, ...handlers);
  return router;
}
