import type { Context, MiddlewareHandler } from 'hono';
import { httpMsOf, newQueryTiming, type QueryTiming, withQueryTiming } from '../db/query-timing.js';
import { type RepeatedShape, repeatedShapes, shapeTextOf } from '../db/statement-shapes.js';
import { logger } from '../lib/logger.js';
import { timeOutboundHttp } from '../lib/outbound-timing.js';
import { authUserRow } from './auth.js';
import { onAdminList } from './require-admin.js';
import { routeRefMs } from './route-refs.js';

export const SERVER_TIMING_HEADER = 'Server-Timing';

/**
 * The most repeated statement shapes of each named part of a request, sent only to an operator of
 * this Forge: `<part>: <fingerprint>*<count> …; …`, fingerprints and counts, never a bound value.
 */
export const STATEMENT_SHAPES_HEADER = 'X-Forge-Statement-Shapes';

/** How many repeated shapes each part names. */
const SHAPES_PER_PART = 3;

const ms = (n: number) => n.toFixed(1);

const queriesOf = (n: number) => `${n} ${n === 1 ? 'query' : 'queries'}`;

const callsOf = (n: number) => `${n} ${n === 1 ? 'call' : 'calls'}`;

/**
 * `http;dur=…;desc="N calls"`, every outbound HTTP call the request waited on, then
 * `http-<provider>;dur=…;desc="N calls"` for each provider that made one: counts and times, never a
 * URL, host or secret.
 */
function httpLegsOf(timing: QueryTiming, now: number): string[] {
  const leg = (name: string, clock: QueryTiming['http']) =>
    `${name};dur=${ms(httpMsOf(clock, now))};desc="${callsOf(clock.calls)}"`;
  return [
    leg('http', timing.http),
    ...[...timing.httpBy].map(([provider, clock]) => leg(`http-${provider}`, clock)),
  ];
}

/**
 * Each named part of the request (`db/query-timing.ts:withQueryLeg`) as `name;dur=…;desc="N queries"`,
 * then `unnamed;desc="N queries"` for the statements sent outside every part: names, times and
 * counts, never any of the data read.
 */
function legsOf(timing: QueryTiming): string[] {
  if (timing.legs.size === 0) return [];
  const named = [...timing.legs].map(
    ([name, leg]) =>
      `${name};dur=${ms(leg.endedAt - leg.startedAt)};desc="${queriesOf(leg.queries)}${leg.calls > 0 ? `, ${callsOf(leg.calls)}` : ''}"`,
  );
  const inLegs = [...timing.legs.values()].reduce((n, leg) => n + leg.queries, 0);
  return [...named, `unnamed;desc="${queriesOf(timing.queries - inLegs)}"`];
}

/**
 * `db;dur=…;desc="N queries", app;dur=…, total;dur=…` — what the origin spent, readable in any
 * browser; `ref;dur=…` ahead of them when a slug or display key was resolved before routing, the
 * outbound HTTP calls after them ({@link httpLegsOf}, inside `app`), and each named part last where
 * the route names its parts, with the calls made inside it.
 */
export function serverTimingValue(timing: QueryTiming, totalMs: number, refMs?: number): string {
  const db = Math.min(timing.dbMs, totalMs);
  return [
    ...(refMs === undefined ? [] : [`ref;dur=${ms(refMs)};desc="slug and key lookups"`]),
    `db;dur=${ms(db)};desc="${queriesOf(timing.queries)}"`,
    `app;dur=${ms(totalMs - db)}`,
    `total;dur=${ms(totalMs)}`,
    ...httpLegsOf(timing, performance.now()),
    ...legsOf(timing),
  ].join(', ');
}

/**
 * Each named part's ({@link legsOf}) and the unnamed statements' most repeated shapes, where any
 * repeats: what a read sends once a row or once a project, named so a count read live is turned into
 * its statement here (`db/statement-shapes.ts:shapeTextOf`).
 */
export function repeatedShapesOf(timing: QueryTiming): Map<string, RepeatedShape[]> {
  const parts = new Map<string, RepeatedShape[]>();
  for (const [name, sent] of [
    ...[...timing.legs].map(([name, leg]) => [name, leg.sent] as const),
    ['unnamed', timing.sent] as const,
  ]) {
    const top = repeatedShapes(sent, SHAPES_PER_PART);
    if (top.length > 0) parts.set(name, top);
  }
  return parts;
}

export const statementShapesValue = (parts: ReadonlyMap<string, RepeatedShape[]>): string =>
  [...parts]
    .map(([name, top]) => `${name}: ${top.map((s) => `${s.fingerprint}*${s.count}`).join(' ')}`)
    .join('; ');

/**
 * Whether the caller is an operator of this Forge: its verified address on the admin list, the grant
 * the instance's own diagnostics declare (`permissions/declared.ts:requiresInstanceAdmin`), read from
 * the row the request's auth gate already holds.
 */
async function isOperator(c: Context): Promise<boolean> {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return false;
  const row = await authUserRow(c, userId);
  return row !== null && row.emailVerifiedAt !== null && onAdminList(row.email);
}

/** Each fingerprint whose text this process has logged once already. */
const logged = new Set<string>();

/** Logs each shape named to an operator with its text, once a process, so a live count reads as a statement. */
function logShapes(parts: ReadonlyMap<string, RepeatedShape[]>): void {
  const fresh = [...parts.values()].flat().filter((s) => !logged.has(s.fingerprint));
  if (fresh.length === 0) return;
  for (const s of fresh) logged.add(s.fingerprint);
  logger.info(
    {
      shapes: fresh.map((s) => ({
        fingerprint: s.fingerprint,
        statement: shapeTextOf(s.fingerprint),
      })),
    },
    'statement shapes named to an operator',
  );
}

/**
 * Stamps every response with the time this process spent on it and how much of that was the
 * database, so a reader's devtools separate the origin's share of a wait from the network's. A
 * cross-origin page reads it only where `Timing-Allow-Origin` names it, which `allowOrigin` decides.
 */
export const serverTiming = (allowOrigin: (origin: string) => boolean): MiddlewareHandler => {
  timeOutboundHttp();
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
    // what a read repeats, named to an operator only: for anyone else no shape is even made
    if (timing.legs.size === 0 || !(await isOperator(c))) return;
    const parts = repeatedShapesOf(timing);
    if (parts.size === 0) return;
    c.res.headers.set(STATEMENT_SHAPES_HEADER, statementShapesValue(parts));
    logShapes(parts);
  };
};
