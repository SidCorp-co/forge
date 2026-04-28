import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

/**
 * Wipe every user table in the current search_path schema with a single
 * TRUNCATE. Call from `beforeEach` to give each test a clean slate without
 * paying migration / schema-creation cost per test.
 */
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

  await db.execute(sql.raw(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`));
}
