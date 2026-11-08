import { AsyncLocalStorage } from 'node:async_hooks';
import type postgres from 'postgres';

/**
 * What one request spent in the database: how many statements it sent, and the wall time during
 * which at least one of them (or a transaction holding a connection) was outstanding. Waiting for a
 * pool connection counts, because the person waits for it too.
 */
export interface QueryTiming {
  queries: number;
  dbMs: number;
  inFlight: number;
  openedAt: number;
  /** Statements sent and not yet answered; a transaction waiting on its own body is not one. */
  sending: number;
  /** What waits for the request's next quiet point ({@link whenQuiet}). */
  quiet: QuietWait[];
  /** How many quiet points the request has reached. */
  points: number;
  /** The request's named parts ({@link withQueryLeg}), in the order first entered. */
  legs: Map<string, QueryLeg>;
  /** Each statement text sent outside every part, with how many times: its shapes are read from it. */
  sent: Map<string, number>;
  /** Every outbound HTTP call the request waited on, and each provider's share ({@link outboundCall}). */
  http: HttpClock;
  httpBy: Map<string, HttpClock>;
}

/**
 * Outbound HTTP calls: how many were made, and the wall time during which at least one was
 * outstanding. Counts and times only; no URL, host or header is kept.
 */
export interface HttpClock {
  calls: number;
  ms: number;
  inFlight: number;
  openedAt: number;
}

const newHttpClock = (): HttpClock => ({ calls: 0, ms: 0, inFlight: 0, openedAt: 0 });

/**
 * One named part of a request (a needs-you area, a part of home): the statements sent inside it
 * and no inner part, and the wall time from its first start to its last end, however many projects
 * ran it side by side.
 */
export interface QueryLeg {
  of: QueryTiming;
  queries: number;
  startedAt: number;
  endedAt: number;
  /**
   * Each statement text the part sent, with how many times: an operator reads its most repeated
   * shapes (`db/statement-shapes.ts:repeatedShapes`), never a bound value, which travels apart.
   */
  sent: Map<string, number>;
  /** Outbound HTTP calls made inside the part ({@link outboundCall}). */
  calls: number;
}

/**
 * One wait for a quiet point. `held` answers 0 where it may run now; otherwise it is kept back while
 * any wait that may run now does, and where none may, the waits holding the least run first.
 */
interface QuietWait {
  run: () => void;
  held?: (() => number) | undefined;
}

const timings = new AsyncLocalStorage<QueryTiming>();
const legs = new AsyncLocalStorage<QueryLeg>();

export const newQueryTiming = (): QueryTiming => ({
  queries: 0,
  dbMs: 0,
  inFlight: 0,
  openedAt: 0,
  sending: 0,
  quiet: [],
  points: 0,
  legs: new Map(),
  sent: new Map(),
  http: newHttpClock(),
  httpBy: new Map(),
});

/** The timing of the request this code runs inside, if any. */
export const currentQueryTiming = (): QueryTiming | undefined => timings.getStore();

/** Runs `fn` with every statement it sends counted into `timing`. */
export function withQueryTiming<T>(timing: QueryTiming, fn: () => T): T {
  return timings.run(timing, fn);
}

/**
 * Runs `fn` outside any request's timing: work a request starts and does not wait for (a read kept
 * off its path, `activity/glance-cache.ts`) is not that request's, and counting it there would put
 * its statements on the request's `Server-Timing`.
 */
export function withoutQueryTiming<T>(fn: () => T): T {
  return timings.exit(fn);
}

/**
 * Runs `fn` as the request's part `name`: its statements count to that part as well as to the
 * request, so the request's `Server-Timing` names which part sends them
 * (`middleware/server-timing.ts:serverTimingValue`). A part run again (once a project) adds to its
 * one count. A statement counts to the innermost part only, and a batch read at a quiet point to the
 * part that opened it. Outside a timed request it only runs `fn`.
 */
export async function withQueryLeg<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t = timings.getStore();
  if (!t) return fn();
  const now = performance.now();
  let leg = t.legs.get(name);
  if (!leg) {
    leg = { of: t, queries: 0, startedAt: now, endedAt: now, sent: new Map(), calls: 0 };
    t.legs.set(name, leg);
  }
  const own = leg;
  try {
    return await legs.run(own, fn);
  } finally {
    own.endedAt = Math.max(own.endedAt, performance.now());
  }
}

function open(t: QueryTiming): () => void {
  if (t.inFlight++ === 0) t.openedAt = performance.now();
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    if (--t.inFlight === 0) t.dbMs += performance.now() - t.openedAt;
  };
}

/**
 * Runs `fn` at the request's next quiet point: once every statement it has sent is answered and what
 * those answers set going has run, so every read of the request is then waiting on something not yet
 * sent. A batched read (`db/read-memo.ts:memoizedPerId`) gathers there what all of a request's
 * concurrent reads ask, however many statements each sent before asking. A transaction's body
 * waiting on `fn` is not a statement in flight, so it never holds the point back. While `held`
 * answers more than 0, `fn` waits past points where something else waiting runs ({@link QuietWait}).
 * Outside a timed request the point is the end of this turn.
 */
export function whenQuiet(fn: () => void, held?: () => number): void {
  const t = timings.getStore();
  if (!t) {
    setImmediate(fn);
    return;
  }
  // what runs at the point counts to the part that waited for it, never to whichever answer set it going
  const leg = legs.getStore();
  const run = leg ? () => legs.run(leg, fn) : () => legs.exit(fn);
  t.quiet.push({ run, held });
  if (t.quiet.length === 1) setImmediate(() => settle(t));
}

// Every quiet point runs a wait, so holding one never stops the request: those free to run, else
// those holding the least
function settle(t: QueryTiming): void {
  if (t.sending > 0 || t.quiet.length === 0) return;
  t.points += 1;
  const due = t.quiet.map((w) => ({ w, held: w.held?.() ?? 0 }));
  const least = Math.min(...due.map((d) => d.held));
  const run = due.filter((d) => d.held === least).map((d) => d.w);
  t.quiet = due.filter((d) => d.held !== least).map((d) => d.w);
  for (const w of run) w.run();
  // what ran may have sent nothing (an answer already held): what it kept back waits for the next point
  if (t.quiet.length > 0) setImmediate(() => settle(t));
}

/** How many quiet points the request this code runs inside has reached; 0 outside one. */
export const quietPoints = (): number => timings.getStore()?.points ?? 0;

function openHttp(clock: HttpClock): () => void {
  clock.calls += 1;
  if (clock.inFlight++ === 0) clock.openedAt = performance.now();
  return () => {
    if (--clock.inFlight === 0) clock.ms += performance.now() - clock.openedAt;
  };
}

/**
 * Marks one outbound HTTP call of the request this code runs inside made, as `provider`'s
 * (`lib/outbound-timing.ts` names it); the function it returns marks it answered, once. Outside a
 * timed request it is undefined: a call nobody waits on is no request's.
 */
export function outboundCall(provider: string): (() => void) | undefined {
  const t = timings.getStore();
  if (!t) return undefined;
  const leg = legs.getStore();
  if (leg?.of === t) leg.calls += 1;
  let by = t.httpBy.get(provider);
  if (!by) {
    by = newHttpClock();
    t.httpBy.set(provider, by);
  }
  const closes = [openHttp(t.http), openHttp(by)];
  let answered = false;
  return () => {
    if (answered) return;
    answered = true;
    for (const close of closes) close();
  };
}

/** The wall time `clock`'s calls were outstanding, a call still unanswered counted to now. */
export const httpMsOf = (clock: HttpClock, now = performance.now()): number =>
  clock.ms + (clock.inFlight > 0 ? now - clock.openedAt : 0);

/** Marks a statement of `t` sent; the function it returns marks it answered, once. */
export function statementSent(t: QueryTiming): () => void {
  t.sending += 1;
  let answered = false;
  return () => {
    if (answered) return;
    answered = true;
    // what the answer sets going runs first; a read it starts keeps the point back
    if (--t.sending === 0 && t.quiet.length > 0) setImmediate(() => settle(t));
  };
}

type Unsafe = postgres.Sql['unsafe'];
type Scoped = { unsafe: Unsafe; savepoint?: (...args: unknown[]) => Promise<unknown> };
type LazyQuery = PromiseLike<unknown> & { executed?: boolean; handle: () => unknown };

function timedUnsafe(unsafe: Unsafe): Unsafe {
  return ((...args: Parameters<Unsafe>) => {
    const query = unsafe(...args) as unknown as LazyQuery;
    const t = timings.getStore();
    if (!t) return query;
    t.queries += 1;
    const leg = legs.getStore();
    if (leg?.of === t) leg.queries += 1;
    const sent = leg?.of === t ? leg.sent : t.sent;
    const text = String(args[0]);
    sent.set(text, (sent.get(text) ?? 0) + 1);
    const handle = query.handle;
    query.handle = function (this: LazyQuery) {
      if (!this.executed) {
        const close = open(t);
        const answered = statementSent(t);
        const done = () => {
          close();
          answered();
        };
        Promise.prototype.then.call(this, done, done);
      }
      return handle.call(this);
    };
    return query;
  }) as unknown as Unsafe;
}

function timedScope<S extends Scoped>(scope: S): S {
  scope.unsafe = timedUnsafe(scope.unsafe);
  const savepoint = scope.savepoint;
  if (savepoint) {
    scope.savepoint = (...args: unknown[]) => {
      const last = args.length - 1;
      const fn = args[last];
      if (typeof fn === 'function') args[last] = (inner: Scoped) => fn(timedScope(inner));
      return savepoint(...args);
    };
  }
  return scope;
}

/**
 * Counts every statement the client sends while a {@link withQueryTiming} scope is active, and times
 * every transaction as one interval from asking for its connection to giving it back.
 */
export function timeQueries(client: postgres.Sql): void {
  const scoped = client as unknown as Scoped & { begin: (...args: unknown[]) => Promise<unknown> };
  scoped.unsafe = timedUnsafe(scoped.unsafe);
  const begin = scoped.begin;
  scoped.begin = (...args: unknown[]) => {
    const last = args.length - 1;
    const fn = args[last];
    if (typeof fn === 'function') args[last] = (tx: Scoped) => fn(timedScope(tx));
    const t = timings.getStore();
    if (!t) return begin(...args);
    const close = open(t);
    const held = begin(...args);
    held.then(close, close);
    return held;
  };
}
