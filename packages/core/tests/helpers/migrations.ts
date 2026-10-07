import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export const MIGRATIONS_FOLDER = new URL('../../drizzle/migrations', import.meta.url).pathname;
export const JOURNAL_PATH = 'packages/core/drizzle/migrations/meta/_journal.json';

export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

export interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

export const journal = (): Journal =>
  JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as Journal;

/** The shipped migrations folder cut off after `tag`: the deploy as it was the day `tag` landed. */
function folderThrough(tag: string): string {
  const shipped = journal();
  const at = shipped.entries.findIndex((e) => e.tag === tag);
  if (at < 0) {
    throw new Error(
      `${tag} is not in drizzle/migrations/meta/_journal.json; a migration test names the shipped ` +
        'tag it guards, so a renamed or removed migration stops it here.',
    );
  }
  const entries = shipped.entries.slice(0, at + 1);
  const dir = mkdtempSync(join(tmpdir(), 'forge-migrations-'));
  mkdirSync(join(dir, 'meta'));
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...shipped, entries }));
  for (const e of entries)
    symlinkSync(join(MIGRATIONS_FOLDER, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

async function migrateFrom(
  url: string,
  migrationsFolder: string,
  onNotice: (message: string) => void = () => {},
): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: (n) => onNotice(n.message ?? '') });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end({ timeout: 5 });
  }
}

/** Every drizzle migration, applied the way `src/db/migrate.ts` applies them at boot. */
export function migrateDatabase(url: string): Promise<void> {
  return migrateFrom(url, MIGRATIONS_FOLDER);
}

/** Run the shipped migrations through `tag` against `url`, with drizzle's own migrator, as boot does. */
export async function migrateThrough(
  url: string,
  tag: string,
  onNotice?: (message: string) => void,
): Promise<void> {
  const dir = folderThrough(tag);
  try {
    await migrateFrom(url, dir, onNotice);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
