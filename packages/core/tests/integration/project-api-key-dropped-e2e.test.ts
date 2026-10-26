/**
 * ISS-1389 — the shipped 0331 drops the project API key, and a read of it fails rather than answers.
 *
 * The statements are read out of `0331_a_project_holds_no_key_nothing_reads.sql` rather than
 * restated, because what has to hold is what the deploy executes. A harness database is already at
 * head, so the old shape is put back with a key on a real project row, the shipped file runs over
 * it, and a read naming the column is refused by Postgres by name.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
} from '../helpers/index.js';

const MIGRATION = fileURLToPath(
  new URL(
    '../../drizzle/migrations/0331_a_project_holds_no_key_nothing_reads.sql',
    import.meta.url,
  ),
);

let harness: TestDatabase;

beforeAll(async () => {
  harness = await setupTestDatabase({ own: 'adds projects.api_key and its index' });
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

/** What the projects table holds of the key: its column and its index. */
async function keyShape(): Promise<{ column: boolean; index: boolean }> {
  const rows = (await harness.db.execute(sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'projects' AND column_name = 'api_key') AS column,
           to_regclass('public.projects_api_key_uq') IS NOT NULL AS index
  `)) as unknown as Array<{ column: boolean; index: boolean }>;
  return rows[0] ?? { column: true, index: true };
}

describe('0331 drops the project API key', () => {
  it('a database migrated to head holds neither the column nor its index', async () => {
    expect(await keyShape()).toEqual({ column: false, index: false });
  });

  it('the shipped file drops both from a table that still holds a key, and keeps the row', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    await harness.db.execute(sql`ALTER TABLE projects ADD COLUMN api_key text`);
    await harness.db.execute(
      sql`CREATE UNIQUE INDEX projects_api_key_uq ON projects (api_key) WHERE api_key IS NOT NULL`,
    );
    await harness.db.execute(
      sql`UPDATE projects SET api_key = ${`fk_${'a'.repeat(48)}`} WHERE id = ${project.id}`,
    );
    expect(await keyShape()).toEqual({ column: true, index: true });

    for (const statement of readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')) {
      await harness.db.execute(sql.raw(statement));
    }

    expect(await keyShape()).toEqual({ column: false, index: false });
    const kept = (await harness.db.execute(
      sql`SELECT id FROM projects WHERE id = ${project.id}`,
    )) as unknown as Array<{ id: string }>;
    expect(kept).toEqual([{ id: project.id }]);
  });

  it('a read of the dropped column is refused naming it', async () => {
    // Drizzle wraps the driver's error; Postgres's own words are on its cause.
    const refused = await harness.db.execute(sql`SELECT api_key FROM projects`).then(
      () => null,
      (err: { cause?: { message?: string } }) => err.cause?.message ?? null,
    );
    expect(refused).toBe('column "api_key" does not exist');
  });
});
