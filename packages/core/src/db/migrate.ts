import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import {
  type JournalEntry,
  describeUnrecorded,
  findUnrecordedMigrations,
} from './migration-audit.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[migrate] DATABASE_URL not set');
  process.exit(1);
}

const migrationsFolder = new URL('../../drizzle/migrations', import.meta.url).pathname;
const sql = postgres(url, { max: 1 });
const db = drizzle(sql);

try {
  console.log('[migrate] applying migrations from', migrationsFolder);
  // cm:guard a migration's `when` in meta/_journal.json must exceed every already-recorded created_at or it's silently skipped forever, not an error (ISS-807)
  await migrate(db, { migrationsFolder });

  // cm:guard ISS-809 — this is a WARNING, never an exit. Measured on forge-beta 2026-08-11: 3 journal entries (0041_pm_agent, 0062_personal_access_tokens, 0063_mcp_audit_log) have no bookkeeping row, yet every table they create EXISTS. The DDL ran; only the ledger is incomplete. A hard gate here would refuse to start a container whose schema is entirely correct — turning a reporting gap into an outage. The authored-wrong case ISS-807 actually hit is caught before merge by migrations-journal.test.ts instead.
  const journal = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, 'utf8')) as {
    entries: JournalEntry[];
  };
  const recorded = await sql<{ created_at: string }[]>`
    SELECT created_at FROM drizzle.__drizzle_migrations
  `;
  const unrecorded = findUnrecordedMigrations(
    journal.entries,
    recorded.map((r) => Number(r.created_at)),
  );
  if (unrecorded.length > 0) console.warn(describeUnrecorded(unrecorded));

  console.log(
    `[migrate] done — journal ${journal.entries.length}, recorded ${recorded.length}, unrecorded ${unrecorded.length}`,
  );
} catch (err) {
  console.error('[migrate] failed', err);
  process.exit(1);
} finally {
  await sql.end();
}
