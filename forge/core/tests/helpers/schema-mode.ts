import { randomBytes } from 'node:crypto';
import postgres from 'postgres';

export interface SchemaHandle {
  url: string;
  schemaName: string;
  drop: () => Promise<void>;
}

/**
 * Create a disposable Postgres schema inside TEST_DATABASE_URL and return a
 * connection URL whose `search_path` is pinned to that schema. Used when
 * TEST_DB_MODE=schema (local dev — reuses a long-lived Postgres, no container
 * boot per run).
 *
 * Each call produces a unique schema name derived from the Vitest worker id
 * plus a random suffix, so parallel test files cannot collide.
 */
export async function createTestSchema(baseUrl: string, workerId: string): Promise<SchemaHandle> {
  const suffix = randomBytes(4).toString('hex');
  const schemaName = `test_w${workerId}_${suffix}`;

  const admin = postgres(baseUrl, { max: 1 });
  try {
    await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  // Append a search_path override via libpq connection options. postgres-js
  // passes the `options` query param through to libpq, so the downstream
  // connection defaults every statement to the new schema without having to
  // issue `SET search_path` on each checkout.
  const url = new URL(baseUrl);
  url.searchParams.set('options', `-c search_path=${schemaName}`);

  return {
    url: url.toString(),
    schemaName,
    drop: async () => {
      const dropClient = postgres(baseUrl, { max: 1 });
      try {
        await dropClient.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
      } finally {
        await dropClient.end({ timeout: 5 });
      }
    },
  };
}
