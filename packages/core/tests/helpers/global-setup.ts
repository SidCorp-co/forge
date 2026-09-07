import type { TestProject } from 'vitest/node';
import { reapAbandoned, templateDbName } from './scratch-db.js';

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

let stopContainer: (() => Promise<void>) | null = null;
let ownedTemplate: { url: string; name: string } | null = null;

// cm:guard the template must have ZERO open connections when a worker clones it — `CREATE DATABASE ... TEMPLATE` fails with "source database is being accessed by other users"
// cm:guard CREATE only, and never `DROP DATABASE IF EXISTS` first. The drop was safe only while the name was this run's alone to hold, and it never was: the name was the constant `forge_test_tpl`, so a second run entering setup deleted the template the first was mid-clone from and the loser blamed a missing Postgres object (ISS-937). The name now comes from `templateDbName()`, which is why there is nothing here to drop.
async function buildTemplate(adminUrl: string, name: string): Promise<void> {
  const postgres = (await import('postgres')).default;
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { runMigrations } = await import('./migrate.js');

  const admin = postgres(adminUrl, { max: 1 });
  try {
    await reapAbandoned(admin);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const tplUrl = new URL(adminUrl);
  tplUrl.pathname = `/${name}`;
  const tplClient = postgres(tplUrl.toString(), { max: 1 });
  try {
    await runMigrations(drizzle(tplClient));
  } finally {
    await tplClient.end({ timeout: 5 });
  }
}

export async function setup(_project: TestProject): Promise<void> {
  // cm:why an operator-supplied Postgres wins over a container — it skips the 6.2s boot entirely
  let adminUrl = process.env.TEST_DATABASE_URL;

  if (!adminUrl) {
    const { startPostgresContainer } = await import('./container.js');
    const container = await startPostgresContainer();
    adminUrl = container.url;
    stopContainer = container.stop;
  }

  const name = templateDbName();
  await buildTemplate(adminUrl, name);
  ownedTemplate = { url: adminUrl, name };

  // cm:edge contract -> packages/core/tests/helpers/db.ts — these two env names are the whole handshake; renaming one here silently reverts every worker to the slow per-file container path
  process.env.TEST_PG_ADMIN_URL = adminUrl;
  process.env.TEST_PG_TEMPLATE = name;
}

// cm:guard drop only `ownedTemplate` — the one name this process minted. Reaching for a prefix, or for whatever `TEST_PG_TEMPLATE` happens to hold, is how teardown becomes the thing that deletes a concurrent run's template; anything this run did NOT create leaves by age through `reapAbandoned`, never by name from here.
export async function teardown(): Promise<void> {
  if (ownedTemplate) {
    const postgres = (await import('postgres')).default;
    const admin = postgres(ownedTemplate.url, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${ownedTemplate.name}" WITH (FORCE)`);
    } catch {
    } finally {
      await admin.end({ timeout: 5 });
      ownedTemplate = null;
    }
  }
  if (stopContainer) {
    await stopContainer();
    stopContainer = null;
  }
}
