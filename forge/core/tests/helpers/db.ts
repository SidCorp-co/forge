import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { startPostgresContainer } from './container.js';
import { runMigrations } from './migrate.js';
import { createTestSchema } from './schema-mode.js';

export type TestDb = PostgresJsDatabase<Record<string, unknown>>;

export interface TestDatabase {
  db: TestDb;
  /** Mode actually used (resolved after TEST_DB_MODE defaulting). */
  mode: 'container' | 'schema';
  /** Raw postgres-js client — exposed for `end()` and advanced uses. */
  client: Sql;
  /** Connection URL the harness is pinned to — useful for wiring
   * `process.env.DATABASE_URL` before importing the app under test. */
  url: string;
  /** Stop the connection + tear down the container / drop the schema. */
  cleanup: () => Promise<void>;
}

/**
 * Boot a per-test-file test database and return a drizzle client bound to it.
 *
 * Mode selection:
 * - `TEST_DB_MODE=container` → throwaway Testcontainers Postgres (CI default).
 * - `TEST_DB_MODE=schema`    → disposable schema inside `TEST_DATABASE_URL`
 *                              (local dev default; requires a long-lived
 *                              Postgres, e.g. `docker compose up postgres`).
 *
 * Default when unset: `schema` if `TEST_DATABASE_URL` is provided, else
 * `container`. This makes the local flow Just Work once developers set
 * `TEST_DATABASE_URL` in `.env.test`, and CI works out of the box with Docker.
 */
export async function setupTestDatabase(): Promise<TestDatabase> {
  const mode = resolveMode();

  const workerId = process.env.VITEST_POOL_ID ?? '0';

  let url: string;
  let teardown: () => Promise<void>;

  if (mode === 'container') {
    const container = await startPostgresContainer();
    url = container.url;
    teardown = container.stop;
  } else {
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (!baseUrl) {
      throw new Error(
        'TEST_DATABASE_URL is required when TEST_DB_MODE=schema. ' +
          'Start a local Postgres (`docker compose up postgres`) and export ' +
          'TEST_DATABASE_URL=postgres://forge:forge_secret@localhost:5432/forge.',
      );
    }
    const schema = await createTestSchema(baseUrl, workerId);
    url = schema.url;
    teardown = schema.drop;
  }

  const client = postgres(url, { max: 4, onnotice: () => {} });
  const db = drizzle(client, {});

  try {
    await runMigrations(db);
  } catch (err) {
    await client.end({ timeout: 5 }).catch(() => {});
    await teardown().catch(() => {});
    throw err;
  }

  return {
    db,
    mode,
    client,
    url,
    cleanup: async () => {
      try {
        await client.end({ timeout: 5 });
      } finally {
        await teardown();
      }
    },
  };
}

function resolveMode(): 'container' | 'schema' {
  const raw = process.env.TEST_DB_MODE;
  if (raw === 'container' || raw === 'schema') return raw;
  return process.env.TEST_DATABASE_URL ? 'schema' : 'container';
}
