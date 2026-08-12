/**
 * ISS-809 — the post-migrate ledger audit against a real, fully-migrated database.
 *
 * The unit tests prove the comparison. This proves the two assumptions it rests
 * on, which are properties of drizzle and of this repo rather than of my code:
 * that `drizzle.__drizzle_migrations.created_at` really is the journal's `when`,
 * and that a database the migrator has finished with records EVERY entry. If a
 * future drizzle version changes either, the audit would start failing every
 * deploy — better to learn that here than at container start.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDatabase, type TestDatabase } from '../helpers/index.js';

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  findUnrecordedMigrations: typeof import('../../src/db/migration-audit.js').findUnrecordedMigrations;
};

const journalPath = fileURLToPath(
  new URL('../../drizzle/migrations/meta/_journal.json', import.meta.url),
);

describe('migration audit E2E (ISS-809)', () => {
  let harness: TestDatabase;
  let mods: Mods;
  let entries: { idx: number; when: number; tag: string }[];
  let recorded: number[];

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';

    mods = (await import('../../src/db/migration-audit.js')) as unknown as Mods;
    entries = (
      JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: { idx: number; when: number; tag: string }[];
      }
    ).entries;
    const rows = (await harness.db.execute(
      sql`SELECT created_at FROM drizzle.__drizzle_migrations`,
    )) as unknown as { created_at: string | number }[];
    recorded = rows.map((r) => Number(r.created_at));
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  it('records at least one migration — otherwise the audit would be vacuous', () => {
    expect(recorded.length).toBeGreaterThan(0);
  });

  // cm:guard a fresh database is the one case where the ledger MUST be complete — if this fails, drizzle changed how it records migrations and every deploy will start warning
  it('reports zero unrecorded migrations against a freshly migrated database', () => {
    const missing = mods.findUnrecordedMigrations(entries, recorded);
    expect(missing.map((m) => m.tag)).toEqual([]);
  });

  it('created_at really is the journal `when` — the join key the audit assumes', () => {
    const whens = new Set(entries.map((e) => e.when));
    const unknownRows = recorded.filter((c) => !whens.has(c));
    expect(unknownRows).toEqual([]);
  });

  it('detects an entry with no ledger row, on this same real recorded set', () => {
    const planted = [...entries, { idx: 9999, when: 1, tag: 'never_ran' }];
    const missing = mods.findUnrecordedMigrations(planted, recorded);
    expect(missing.map((m) => m.tag)).toEqual(['never_ran']);
  });
});
