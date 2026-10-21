import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { queryRefused } from '../../lib/query-strict.js';
import { ownHandlers, type ValidatorDeclaration, validatorDeclarations } from './declarations.js';

/** Query keys a gate ahead of the routes reads, each with why; one added here every GET route takes. */
export const QUERY_GATE_KEYS: Readonly<Record<string, string>> = {};

const READS = new Set(['GET', 'HEAD']);

/** The paths the query gate is mounted over, which the reference states it on and no others. */
export const queryGateCovers = (path: string): boolean => path.startsWith('/api/');

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
