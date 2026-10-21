import type { Context } from 'hono';
import { matchedRoutes } from 'hono/route';
import { findTargetHandler } from 'hono/utils/handler';
import type { ZodType } from 'zod';

/** What a route's input validator was built from, which the mounted middleware no longer shows. */
export type ValidatorDeclaration = {
  readonly target: 'param' | 'query' | 'json' | 'form' | 'header' | 'cookie';
  readonly schema: ZodType;
  readonly hook: ((...args: never[]) => unknown) | null;
  readonly enforced?: boolean;
};

export const validatorDeclarations = new WeakMap<object, ValidatorDeclaration>();

/** The handlers of the route that answers this request, its gates mounted for every path aside. */
export function ownHandlers(c: Context): object[] | null {
  const matched = matchedRoutes(c);
  const route = matched.find((r) => r.method !== 'ALL');
  if (!route) return null;
  return matched
    .filter((r) => r.method === route.method && r.path === route.path)
    .map((r) => findTargetHandler(r.handler as never) as object);
}
