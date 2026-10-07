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
}

const timings = new AsyncLocalStorage<QueryTiming>();

export const newQueryTiming = (): QueryTiming => ({
  queries: 0,
  dbMs: 0,
  inFlight: 0,
  openedAt: 0,
});

/** The timing of the request this code runs inside, if any. */
export const currentQueryTiming = (): QueryTiming | undefined => timings.getStore();

/** Runs `fn` with every statement it sends counted into `timing`. */
export function withQueryTiming<T>(timing: QueryTiming, fn: () => T): T {
  return timings.run(timing, fn);
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

type Unsafe = postgres.Sql['unsafe'];
type Scoped = { unsafe: Unsafe; savepoint?: (...args: unknown[]) => Promise<unknown> };
type LazyQuery = PromiseLike<unknown> & { executed?: boolean; handle: () => unknown };

function timedUnsafe(unsafe: Unsafe): Unsafe {
  return ((...args: Parameters<Unsafe>) => {
    const query = unsafe(...args) as unknown as LazyQuery;
    const t = timings.getStore();
    if (!t) return query;
    t.queries += 1;
    const handle = query.handle;
    query.handle = function (this: LazyQuery) {
      if (!this.executed) {
        const close = open(t);
        Promise.prototype.then.call(this, close, close);
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
