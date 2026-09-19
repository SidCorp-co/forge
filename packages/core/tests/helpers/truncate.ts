import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

export async function truncateAll(db: PostgresJsDatabase<Record<string, unknown>>): Promise<void> {
  const rows = await db.execute<{ table_name: string }>(sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_type = 'BASE TABLE'
  `);

  const tables: string[] = [];
  for (const row of rows) {
    const name = (row as { table_name?: unknown }).table_name;
    if (typeof name === 'string' && name !== '__drizzle_migrations') {
      tables.push(`"${name}"`);
    }
  }

  if (tables.length === 0) return;

  const truncate = sql.raw(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);

  const MAX_ATTEMPTS = 25;
  for (let attempt = 1; ; attempt++) {
    try {
      await db.execute(truncate);
      return;
    } catch (err) {
      const code = pgErrorCode(err);
      if ((code !== '40P01' && code !== '55P03') || attempt >= MAX_ATTEMPTS) throw err;
      // Growing, de-synchronizing backoff so the next attempt lands after the
      // competing write commits (cap bounds total wait under a long burst).
      await new Promise((r) => setTimeout(r, Math.min(20 * attempt + ((attempt * 13) % 17), 400)));
    }
  }
}

/** Pull a Postgres SQLSTATE from a (possibly drizzle-wrapped) error chain. */
function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}
