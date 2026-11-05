// Every Postgres connection one core process may hold, declared once (ISS-1020). The server is
// shared with other apps, and a deploy runs the old container beside the new one until the old has
// drained, so the peak is two of these budgets. Each client below draws its pool from its share and
// no client opens a connection outside it.

/**
 * The default total: two containers overlapping in a deploy hold 24, where the four separate pools
 * this replaces held about 23 each and peaked near 44 against a server with 97 usable slots.
 */
export const DEFAULT_DATABASE_CONNECTIONS = 12;

/** The smallest total that still leaves the query pool room for a transaction beside a plain read. */
export const MIN_DATABASE_CONNECTIONS = 8;

/** Which client holds which part of a process's connections. */
export type ConnectionBudget = Readonly<{
  total: number;
  /**
   * The postgres.js pool every route and job handler queries through (`db/client.ts`). The org
   * activity read sends its eight legs at once (`activity/read.ts:readOrgActivity`), so eight lets
   * the widest request run unqueued; any other request queues for a connection, it is never refused.
   */
  queries: number;
  /**
   * pg-boss's own pool (`queue/boss.ts`): a worker's fetch, a fail or retry, the cron and the
   * maintenance sweep, each one statement. A handler's work, and the outbox's completion, run in
   * the query pool's transaction instead. `useListenNotify` would open one more connection outside
   * this share, so it stays off.
   */
  queue: number;
  /** The rate limiter's store (`middleware/rate-limit.ts`): one upsert per limited request. */
  rateLimit: number;
  /**
   * The one session connection the Rocket.Chat manager holds: its reload LISTEN and the session
   * advisory lock of every chat connection this process owns (`integrations/rocketchat`).
   */
  session: number;
}>;

/** Splits `total` across the clients; a total too small for the query pool is refused by name. */
export function connectionBudget(total: number): ConnectionBudget {
  if (!Number.isInteger(total) || total < MIN_DATABASE_CONNECTIONS) {
    throw new Error(
      `DATABASE_CONNECTIONS=${total} is not a connection budget: it takes a whole number of at least ${MIN_DATABASE_CONNECTIONS} (default ${DEFAULT_DATABASE_CONNECTIONS})`,
    );
  }
  const session = 1;
  const rateLimit = 1;
  const queue = Math.max(2, Math.floor(total / 6));
  return { total, queries: total - session - rateLimit - queue, queue, rateLimit, session };
}

/** How each client names itself in `pg_stat_activity`, so an operator can tell the pools apart. */
export const CONNECTION_NAMES = {
  queries: 'forge-core',
  queue: 'forge-core-queue',
  rateLimit: 'forge-core-rate-limit',
  session: 'forge-core-session',
} as const satisfies Record<Exclude<keyof ConnectionBudget, 'total'>, string>;
