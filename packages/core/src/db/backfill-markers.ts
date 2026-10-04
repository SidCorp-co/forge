import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import type { Tx } from './client.js';

type Sql = postgres.Sql<Record<string, never>>;

/** Whether a once-per-database backfill already recorded its completion, over the raw client. */
export async function backfillMarked(client: Sql, key: string): Promise<boolean> {
  const rows = await client<{ n: number }[]>`
    SELECT count(*)::int AS n FROM backfill_markers WHERE key = ${key}
  `;
  return (rows[0]?.n ?? 0) > 0;
}

/** Record a backfill's completion over the raw client. */
export async function markBackfill(client: Sql, key: string): Promise<void> {
  await client`INSERT INTO backfill_markers (key) VALUES (${key}) ON CONFLICT (key) DO NOTHING`;
}

/** Forget a backfill's completion over the raw client, so the next boot runs it again. */
export async function unmarkBackfill(client: Sql, key: string): Promise<void> {
  await client`DELETE FROM backfill_markers WHERE key = ${key}`;
}

/** Whether a backfill already recorded its completion, inside a drizzle transaction. */
export async function backfillMarkedIn(tx: Tx, key: string): Promise<boolean> {
  const rows = (await tx.execute(
    sql`SELECT count(*)::int AS n FROM backfill_markers WHERE key = ${key}`,
  )) as unknown as Array<{ n: number }>;
  return (rows[0]?.n ?? 0) > 0;
}

/** Record a backfill's completion inside a drizzle transaction. */
export async function markBackfillIn(tx: Tx, key: string): Promise<void> {
  await tx.execute(
    sql`INSERT INTO backfill_markers (key) VALUES (${key}) ON CONFLICT (key) DO NOTHING`,
  );
}
