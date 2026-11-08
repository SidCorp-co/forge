import type { MiddlewareHandler } from 'hono';
import { newQueryTiming, type QueryTiming, withQueryTiming } from '../db/query-timing.js';
import { routeRefMs } from './route-refs.js';

export const SERVER_TIMING_HEADER = 'Server-Timing';

const ms = (n: number) => n.toFixed(1);

const queriesOf = (n: number) => `${n} ${n === 1 ? 'query' : 'queries'}`;

/**
 * Each named part of the request (`db/query-timing.ts:withQueryLeg`) as `name;dur=…;desc="N queries"`,
 * then `unnamed;desc="N queries"` for the statements sent outside every part: names, times and
 * counts, never any of the data read.
 */
function legsOf(timing: QueryTiming): string[] {
  if (timing.legs.size === 0) return [];
  const named = [...timing.legs].map(
    ([name, leg]) =>
      `${name};dur=${ms(leg.endedAt - leg.startedAt)};desc="${queriesOf(leg.queries)}"`,
  );
  const inLegs = [...timing.legs.values()].reduce((n, leg) => n + leg.queries, 0);
  return [...named, `unnamed;desc="${queriesOf(timing.queries - inLegs)}"`];
}

/**
 * `db;dur=…;desc="N queries", app;dur=…, total;dur=…` — what the origin spent, readable in any
 * browser; `ref;dur=…` ahead of them when a slug or display key was resolved before routing, and
 * each named part after them where the route names its parts.
 */
export function serverTimingValue(timing: QueryTiming, totalMs: number, refMs?: number): string {
  const db = Math.min(timing.dbMs, totalMs);
  return [
    ...(refMs === undefined ? [] : [`ref;dur=${ms(refMs)};desc="slug and key lookups"`]),
    `db;dur=${ms(db)};desc="${queriesOf(timing.queries)}"`,
    `app;dur=${ms(totalMs - db)}`,
    `total;dur=${ms(totalMs)}`,
    ...legsOf(timing),
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
