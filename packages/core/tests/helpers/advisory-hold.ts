import { sql } from 'drizzle-orm';
import type { TestDb } from './db.js';

/** Hold `key` until `release`; resolves once Postgres has GRANTED it, not once the transaction began. */
export async function holdAdvisoryKey(
  db: TestDb,
  key: string,
): Promise<{ release: () => Promise<void> }> {
  let letGo = () => {};
  const held = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  let granted = () => {};
  const isGranted = new Promise<void>((resolve) => {
    granted = resolve;
  });
  const holder = db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    granted();
    await held;
  });
  await Promise.race([isGranted, holder]);
  return {
    release: async () => {
      letGo();
      await holder;
    },
  };
}

/** Wait until `pg_locks` shows every caller blocked on `key`; a caller that settles first read around it. */
export async function untilAllBlockedOn(
  db: TestDb,
  key: string,
  callers: Record<string, Promise<unknown>>,
): Promise<void> {
  const settledFirst: string[] = [];
  for (const [name, call] of Object.entries(callers)) {
    call.then(
      () => settledFirst.push(`${name} answered`),
      (err: unknown) => settledFirst.push(`${name} failed: ${String(err)}`),
    );
  }
  const want = Object.keys(callers).length;
  for (;;) {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n
        FROM pg_locks
       WHERE locktype = 'advisory'
         AND NOT granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND classid = ((hashtextextended(${key}, 0) >> 32) & 4294967295)::oid
         AND objid = (hashtextextended(${key}, 0) & 4294967295)::oid
    `)) as unknown as { n: number }[];
    const seen = rows[0]?.n ?? 0;
    if (settledFirst.length > 0) {
      throw new Error(
        `every caller should be BLOCKED on \`${key}\` while the harness holds it, but ` +
          `${settledFirst.join('; ')} with ${seen} of ${want} waiting. A writer that answers ` +
          'while the key is held has not claimed it — it has read around it.',
      );
    }
    if (seen >= want) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}
