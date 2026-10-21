import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { queryRefused } from '../../lib/query-strict.js';
import {
  ownHandlers,
  refuseBodyNotTaken,
  type ValidatorDeclaration,
  validatorDeclarations,
} from './validator.js';

/**
 * Query keys a gate in front of the routes reads, which no route declares, each with why. None
 * today: no middleware on `/api` reads a query. A key added here is one every GET route takes.
 */
export const QUERY_GATE_KEYS: Readonly<Record<string, string>> = {};

const READS = new Set(['GET', 'HEAD']);

export const QUERY_NOT_TAKEN_WHEN = 'the request carries a query key, and this call takes no query';

/** Whether a route is held to no query at all, the one predicate the gate and the reference share. */
export function takesNoQuery(method: string, validators: readonly ValidatorDeclaration[]): boolean {
  return READS.has(method) && !validators.some((v) => v.target === 'query');
}

const NO_QUERY = z.object({}).strict();

/** Refuses each key a read sends where its route declares no query: `?orgId=` was dropped unread. */
export function refuseQueryNotTaken(): MiddlewareHandler {
  return async (c, next) => {
    if (!READS.has(c.req.method)) return next();
    const handlers = ownHandlers(c);
    if (!handlers) return next();
    const declared = handlers.flatMap((h) => validatorDeclarations.get(h) ?? []);
    if (!takesNoQuery(c.req.method, declared)) return next();
    const keys = Object.keys(c.req.queries()).filter((k) => !Object.hasOwn(QUERY_GATE_KEYS, k));
    if (keys.length === 0) return next();
    throw queryRefused(
      [{ code: 'unrecognized_keys', path: [], keys, message: 'Unrecognized keys' }],
      NO_QUERY,
      c.req.query(),
    );
  };
}

/** Both input gates as the app mounts them: a body a write does not take, a key an `/api` read does not. */
export function refuseInputNotTaken(): MiddlewareHandler {
  const body = refuseBodyNotTaken();
  const query = refuseQueryNotTaken();
  return (c, next) =>
    body(c, async () => {
      await (c.req.path.startsWith('/api/') ? query(c, next) : next());
    });
}
