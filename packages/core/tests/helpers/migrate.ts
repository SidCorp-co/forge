import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const MIGRATIONS_FOLDER = resolve(
  // from packages/core/tests/helpers/migrate.ts → packages/core/drizzle/migrations
  new URL('../../drizzle/migrations', import.meta.url).pathname,
);

/**
 * Run Drizzle migrations against the supplied test DB. No-op when the
 * migrations folder does not exist yet (Phase 2.1 is still scaffolding the
 * schema — downstream issues will generate migrations).
 */
export async function runMigrations(
  db: PostgresJsDatabase<Record<string, unknown>>,
): Promise<void> {
  if (!existsSync(MIGRATIONS_FOLDER)) {
    return;
  }
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
