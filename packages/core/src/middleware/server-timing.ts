import type { MiddlewareHandler } from 'hono';
import { newQueryTiming, type QueryTiming, withQueryTiming } from '../db/query-timing.js';
import { routeRefMs } from './route-refs.js';

export const SERVER_TIMING_HEADER = 'Server-Timing';

const ms = (n: number) => n.toFixed(1);

/**
 * `db;dur=…;desc="N queries", app;dur=…, total;dur=…` — what the origin spent, readable in any
 * browser; `ref;dur=…` ahead of them when a slug or display key was resolved before routing.
 */
export function serverTimingValue(timing: QueryTiming, totalMs: number, refMs?: number): string {
  const db = Math.min(timing.dbMs, totalMs);
  return [
    ...(refMs === undefined ? [] : [`ref;dur=${ms(refMs)};desc="slug and key lookups"`]),
    `db;dur=${ms(db)};desc="${timing.queries} ${timing.queries === 1 ? 'query' : 'queries'}"`,
    `app;dur=${ms(totalMs - db)}`,
    `total;dur=${ms(totalMs)}`,
  ].join(', ');
}

/**
 * Stamps every response with the time this process spent on it and how much of that was the
 * database, so a reader's devtools separate the origin's share of a wait from the network's. A
 * cross-origin page reads it only where `Timing-Allow-Origin` names it, which `allowOrigin` decides.
 */
export const serverTiming = (allowOrigin: (origin: string) => boolean): MiddlewareHandler => {
  return async (c, next) => {
    const started = performance.now();
    const timing = newQueryTiming();
    await withQueryTiming(timing, next);
    if (c.res.status === 101) return;
    const value = serverTimingValue(timing, performance.now() - started, routeRefMs(c));
    const origin = c.req.header('origin');
    try {
      c.res.headers.append(SERVER_TIMING_HEADER, value);
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      c.res = new Response(c.res.body, c.res);
      c.res.headers.append(SERVER_TIMING_HEADER, value);
    }
    if (origin && allowOrigin(origin)) c.res.headers.set('Timing-Allow-Origin', origin);
  };
};
