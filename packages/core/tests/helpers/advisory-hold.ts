import { sql } from 'drizzle-orm';
import type { TestDb } from './db.js';

/**
 * Run `body` while the harness holds the advisory lock on `key`, and let the key go on every path
 * out of it. `body` starts only once Postgres has granted the lock: a caller started before that
 * could take the key first, and the case would then turn on which connection reached the server
 * first. A holder that fails before it holds the key fails the case with its own error.
 */
export async function whileHolding<T>(db: TestDb, key: string, body: () => Promise<T>): Promise<T> {
  let letGo = () => {};
  const held = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  let granted = () => {};
  const acquired = new Promise<void>((resolve) => {
    granted = resolve;
  });
  const holder = db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    granted();
    await held;
  });
  await Promise.race([acquired, holder]);
  try {
    return await body();
  } finally {
    letGo();
    await holder;
  }
}

/**
 * Wait until Postgres itself says `want` callers in this database are blocked on `key`, refusing
 * after 10s with `blame`, which says what a caller that never waited is doing instead.
 */
export async function waitingOn(db: TestDb, key: string, want: number, blame: string) {
  const deadline = Date.now() + 10_000;
  let seen = -1;
  while (Date.now() < deadline) {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n
        FROM pg_locks
       WHERE locktype = 'advisory'
         AND NOT granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND classid = ((hashtextextended(${key}, 0) >> 32) & 4294967295)::oid
         AND objid = (hashtextextended(${key}, 0) & 4294967295)::oid
    `)) as unknown as { n: number }[];
    seen = rows[0]?.n ?? 0;
    if (seen >= want) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `${want} callers should be BLOCKED on ${key} while the harness holds it; Postgres reports ` +
      `${seen} waiter(s) after 10s. ${blame}`,
  );
}
