import { randomBytes } from 'node:crypto';
import postgres from 'postgres';

/** Where a run's databases come from: tests/README.md, *Decision — hybrid test DB strategy*. */
export type DbSource = { mode: 'container' } | { mode: 'schema'; url: string };

/**
 * Read `TEST_DB_MODE` as the caller set it: a value that is neither mode, or `schema` with no
 * `TEST_DATABASE_URL` naming the server, is refused by name rather than read as another mode.
 */
export function resolveDbSource(env: Record<string, string | undefined>): DbSource {
  const raw = env.TEST_DB_MODE || undefined;
  const url = env.TEST_DATABASE_URL || undefined;
  if (raw !== undefined && raw !== 'container' && raw !== 'schema') {
    throw new Error(
      `TEST_DB_MODE="${raw}" is not a database mode. It takes "schema" (the Postgres ` +
        'TEST_DATABASE_URL names) or "container" (one Testcontainers boots for this run), or is left ' +
        'unset so TEST_DATABASE_URL decides.',
    );
  }
  const mode = raw ?? (url ? 'schema' : 'container');
  if (mode === 'container') return { mode };
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is required when TEST_DB_MODE=schema. Start the test-only Postgres ' +
        'packages/core/tests/README.md runs under "Integration tests — local" ' +
        '(pgvector/pgvector:pg17 -c fsync=off on port 5433) and export ' +
        'TEST_DATABASE_URL=postgres://forge:forge_secret@localhost:5433/forge. ' +
        'Not the compose `postgres`: it keeps the dev data and syncs to disk.',
    );
  }
  return { mode, url };
}

export interface SchemaHandle {
  url: string;
  schemaName: string;
  drop: () => Promise<void>;
}

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
