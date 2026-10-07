import type { MiddlewareHandler } from 'hono';
import { withReadMemo } from '../db/read-memo.js';

const READS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** A read request shares its repeated lookups (`db/read-memo.ts`); a write request reads afresh. */
export const readMemo = (): MiddlewareHandler => async (c, next) => {
  if (!READS.has(c.req.method)) return next();
  await withReadMemo(next);
};
