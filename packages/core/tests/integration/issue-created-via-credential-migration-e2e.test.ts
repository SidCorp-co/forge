/**
 * ISS-1374 — the shipped migration, run against rows the old code left behind.
 *
 * The statements are read out of `0325_a_create_records_its_credential.sql` rather than restated:
 * what has to hold is what the deploy will execute. The database this file runs on is already
 * migrated, so it first puts the issues table back the way 0324 left it (no token column, the
 * five-value CHECK 0152 wrote), plants the rows the old code wrote, and then runs the shipped file.
 *
 * The property is that no existing row moves. A row a session or a token created before this change
 * reads `web`, whichever it was, and no record holds the credential of a past REST create, so the
 * migration leaves them as they were found with a NULL token id rather than guessing.
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
  new URL('../../drizzle/migrations/0325_a_create_records_its_credential.sql', import.meta.url),
);

let harness: TestDatabase;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

describe('migration 0325 over rows written before it', () => {
  it('moves no row, and leaves every old create reading as it did with no token', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);

    // The state 0324 left: no token column (its FK and index go with it), the 0152 CHECK.
    await harness.db.execute(sql`ALTER TABLE issues DROP COLUMN created_via_token_id`);
    await harness.db.execute(sql`ALTER TABLE issues DROP CONSTRAINT issues_created_via_chk`);
    await harness.db.execute(sql`
      ALTER TABLE issues ADD CONSTRAINT issues_created_via_chk
        CHECK (created_via IS NULL OR created_via IN ('web','mcp','pipeline','schedule','system'))
    `);

    // What the old code wrote: every REST create `web`, whatever the credential was.
    const planted = ['web', 'web', 'mcp', 'schedule', null];
    for (const [i, via] of planted.entries()) {
      await harness.db.execute(sql`
        INSERT INTO issues (project_id, title, created_by_id, created_via)
        VALUES (${project.id}, ${`old ${i}`}, ${user.id}, ${via})
      `);
    }
    const before = await harness.db.execute(
      sql`SELECT id, title, created_via FROM issues WHERE project_id = ${project.id} ORDER BY title`,
    );
    expect(before).toHaveLength(planted.length);

    const statements = readFileSync(MIGRATION, 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const statement of statements) await harness.db.execute(sql.raw(statement));

    const after = await harness.db.execute(
      sql`SELECT id, title, created_via, created_via_token_id FROM issues
           WHERE project_id = ${project.id} ORDER BY title`,
    );
    expect(after.map((r) => [r.id, r.title, r.created_via])).toEqual(
      before.map((r) => [r.id, r.title, r.created_via]),
    );
    expect(after.every((r) => r.created_via_token_id === null)).toBe(true);
  });

  it('is additive: the shipped file holds no statement that rewrites or deletes a row', () => {
    const statements = readFileSync(MIGRATION, 'utf8')
      .split('--> statement-breakpoint')
      .map((chunk) =>
        chunk
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('--'))
          .join('\n')
          .trim(),
      )
      .filter((statement) => statement.length > 0);
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((s) => /^(UPDATE|DELETE|INSERT|TRUNCATE)\b/i.test(s))).toEqual([]);
  });
});
