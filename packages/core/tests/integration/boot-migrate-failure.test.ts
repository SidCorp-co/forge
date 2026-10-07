/**
 * The boot's migrate step against a real Postgres: a migration that fails, and one that waits on a
 * lock another session holds, each end the boot with exit 1 and a report naming the migration —
 * never a silent crash loop, never a wait with nothing logged.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateAtBoot } from '../../src/db/migrate.js';
import { provideErrorTracker } from '../../src/lib/error-tracking.js';
import { MIGRATIONS_FOLDER } from '../helpers/migrations.js';

const DAY = 86_400_000;
const shipped = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
const last = shipped.entries.at(-1);
let next = 0;
const folders: string[] = [];

/** The shipped migrations plus one more, `tag`, holding `statements` — pending on the file's database. */
function folderWith(tag: string, statements: string[]): string {
  next += 1;
  const dir = mkdtempSync(join(tmpdir(), 'forge-boot-migrate-'));
  folders.push(dir);
  mkdirSync(join(dir, 'meta'));
  const entry = { ...last, idx: last.idx + next, when: last.when + next * DAY, tag };
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({ ...shipped, entries: [...shipped.entries, entry] }),
  );
  for (const e of shipped.entries)
    symlinkSync(join(MIGRATIONS_FOLDER, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  writeFileSync(join(dir, `${tag}.sql`), statements.join('\n--> statement-breakpoint\n'));
  return dir;
}

const url = (): string => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error('DATABASE_URL is unset: run under the integration config');
  return value;
};

let reports: { message: string; context: Record<string, unknown> }[];
let flushed: number;
let sql: postgres.Sql;

beforeEach(() => {
  reports = [];
  flushed = 0;
  provideErrorTracker({
    captureException: () => {},
    captureMessage: (message, context) => {
      reports.push({ message, context: context as Record<string, unknown> });
    },
    addBreadcrumb: () => {},
    flush: async () => {
      flushed += 1;
      return true;
    },
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  sql = postgres(url(), { max: 2, onnotice: () => {} });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await sql.end({ timeout: 5 });
});

afterAll(() => {
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
});

async function recordedCount(): Promise<number> {
  const [row] = await sql<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
  return row?.n ?? 0;
}

describe('migrateAtBoot', () => {
  it('a migration whose statement fails on a row the table holds exits 1 and reports that migration', async () => {
    const tag = '9001_reset_before_drop_not_null';
    const folder = folderWith(tag, [
      'CREATE TABLE boot_probe_prefs (id int PRIMARY KEY, language text NOT NULL);',
      "INSERT INTO boot_probe_prefs VALUES (1, 'en');",
      'UPDATE boot_probe_prefs SET language = NULL;',
    ]);
    const before = await recordedCount();

    expect(await migrateAtBoot(url(), { migrationsFolder: folder })).toBe(1);

    expect(reports).toHaveLength(1);
    expect(flushed, 'the report is flushed before the process exits').toBe(1);
    expect(reports[0]?.message).toMatch(
      new RegExp(`^db\\.migrate: boot migration failed while applying at ${tag}: .*not-null`),
    );
    expect(reports[0]?.context).toMatchObject({
      level: 'fatal',
      tags: { area: 'db-migrate', stage: 'applying', migration: tag, code: '23502' },
      extra: {
        migration: tag,
        pending: [tag],
        recorded: before,
        journal: shipped.entries.length + 1,
      },
    });
    expect(await recordedCount(), 'the failed migration rolled back, unrecorded').toBe(before);
  });

  it('a migration waiting on a lock another session holds fails by name at the lock timeout', async () => {
    const tag = '9002_alter_a_locked_table';
    const folder = folderWith(tag, ['ALTER TABLE users ADD COLUMN boot_probe text;']);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const held = sql.begin(async (tx) => {
      await tx`LOCK TABLE users IN ACCESS EXCLUSIVE MODE`;
      locked();
      await released;
    });
    await isLocked;
    const began = Date.now();
    try {
      expect(await migrateAtBoot(url(), { migrationsFolder: folder, lockTimeoutMs: 1_000 })).toBe(
        1,
      );
    } finally {
      release();
      await held;
    }

    expect(Date.now() - began, 'bounded by the lock timeout, not by the holder').toBeLessThan(
      15_000,
    );
    expect(reports[0]?.context).toMatchObject({
      level: 'fatal',
      tags: { stage: 'applying', migration: tag, code: '55P03' },
    });
    const [column] = await sql`
      SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'boot_probe'
    `;
    expect(column).toBeUndefined();
  });

  it('a pending migration that applies exits 0, records it, and reports nothing', async () => {
    const folder = folderWith('9003_applies', ['CREATE TABLE boot_probe_ok (id int PRIMARY KEY);']);
    const before = await recordedCount();

    expect(await migrateAtBoot(url(), { migrationsFolder: folder })).toBe(0);

    expect(await recordedCount()).toBe(before + 1);
    expect(reports).toEqual([]);
  });

  it('an unset DATABASE_URL exits 1 and reports the environment stage', async () => {
    expect(await migrateAtBoot(undefined)).toBe(1);
    expect(reports[0]?.context).toMatchObject({
      tags: { stage: 'environment' },
      extra: { error: 'DATABASE_URL is not set', recorded: null },
    });
  });
});
