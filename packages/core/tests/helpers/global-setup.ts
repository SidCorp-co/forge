import type { TestProject } from 'vitest/node';

/**
 * Integration global setup — runs ONCE per `vitest run`, in the main process.
 *
 * Starts a single Postgres and migrates it into a TEMPLATE database. Each test
 * file then clones that template (`CREATE DATABASE ... TEMPLATE`), which
 * Postgres does as a file copy, instead of booting its own container and
 * replaying every migration.
 *
 * Measured on this repo before the change: 6.2s container boot + 1.7s for 166
 * migrations = ~8.6s of setup per test FILE, 37 files, no reuse.
 */

const TEMPLATE_DB = 'forge_test_tpl';

let stopContainer: (() => Promise<void>) | null = null;

// cm:guard the template must have ZERO open connections when a worker clones it —
// `CREATE DATABASE ... TEMPLATE` fails with "source database is being accessed by other users"
async function buildTemplate(adminUrl: string): Promise<void> {
  const postgres = (await import('postgres')).default;
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { runMigrations } = await import('./migrate.js');

  const admin = postgres(adminUrl, { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}"`);
    await admin.unsafe(`CREATE DATABASE "${TEMPLATE_DB}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const tplUrl = new URL(adminUrl);
  tplUrl.pathname = `/${TEMPLATE_DB}`;
  const tplClient = postgres(tplUrl.toString(), { max: 1 });
  try {
    await runMigrations(drizzle(tplClient));
  } finally {
    await tplClient.end({ timeout: 5 });
  }
}

export async function setup(_project: TestProject): Promise<void> {
  // cm:why an operator-supplied Postgres wins over a container — it skips the 6.2s boot entirely
  let adminUrl = process.env['TEST_DATABASE_URL'];

  if (!adminUrl) {
    const { startPostgresContainer } = await import('./container.js');
    const container = await startPostgresContainer();
    adminUrl = container.url;
    stopContainer = container.stop;
  }

  await buildTemplate(adminUrl);

  // cm:edge contract -> packages/core/tests/helpers/db.ts — these two env names are the whole handshake; renaming one here silently reverts every worker to the slow per-file container path
  process.env['TEST_PG_ADMIN_URL'] = adminUrl;
  process.env['TEST_PG_TEMPLATE'] = TEMPLATE_DB;
}

export async function teardown(): Promise<void> {
  if (stopContainer) {
    await stopContainer();
    stopContainer = null;
  }
}
