/**
 * ISS-1108 — the database's own half of "`closed` means the work shipped".
 *
 * `issues/apply-transition.ts` refuses such a close by name, and that refusal is
 * proved in unit tests against the transition writer. This file proves the half
 * that holds whatever wrote the row: a `BEFORE UPDATE`/`BEFORE INSERT` trigger
 * installed by migration 0290, which no application code can be routed around.
 * A mocked `db.execute` can express none of it.
 *
 * The migration's own refusal is read from the migration file rather than
 * restated, so what is proved is what will run at the deploy.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const MIGRATION = fileURLToPath(
  new URL('../../drizzle/migrations/0290_closed_means_shipped.sql', import.meta.url),
);

let harness: TestDatabase;
let projectId: string;
let userId: string;
let seq = 0;

/**
 * The Postgres message, not drizzle's wrapper. A failed `db.execute` throws
 * `Failed query: <sql>` and hangs the server's own message off `cause`, so
 * asserting on the outer message would pass for any failure at all.
 */
async function refusalFrom(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const parts: string[] = [];
    let cursor: unknown = err;
    while (cursor instanceof Error) {
      parts.push(cursor.message);
      cursor = (cursor as { cause?: unknown }).cause;
    }
    return parts.join('\n');
  }
  throw new Error('expected the write to be refused, and it was not');
}

async function seedIssue(opts: { status?: string; merged?: boolean } = {}) {
  const id = randomUUID();
  const issSeq = ++seq;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, created_by_id, title, description, status, merged_at)
    VALUES (${id}, ${projectId}, ${issSeq}, ${userId}, 'a row the rule is judged on', 'fixture',
            ${opts.status ?? 'in_progress'}, ${opts.merged ? sql`now()` : null})
  `);
  return { id, issSeq };
}

async function statusOf(id: string): Promise<string> {
  const rows = await harness.db.execute<{ status: string }>(
    sql`SELECT status FROM issues WHERE id = ${id}`,
  );
  return (rows[0] as { status: string }).status;
}

/** Both triggers, so a row the new meaning cannot represent can be planted. */
async function dropTheRule() {
  await harness.db.execute(sql`DROP TRIGGER IF EXISTS trg_issues_closed_means_shipped ON issues`);
  await harness.db.execute(
    sql`DROP TRIGGER IF EXISTS trg_issues_closed_means_shipped_ins ON issues`,
  );
}

async function runMigration() {
  const text = readFileSync(MIGRATION, 'utf8');
  for (const statement of text.split('--> statement-breakpoint')) {
    if (statement.trim()) await harness.db.execute(sql.raw(statement));
  }
}

beforeAll(async () => {
  harness = await setupTestDatabase();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, owner.id);
  userId = owner.id;
  projectId = project.id;
});

afterAll(async () => {
  await harness.cleanup();
});

describe('no route reaches `closed` without the shipped-work claim (ISS-1108)', () => {
  it('refuses a raw UPDATE, naming the issue, the rule and the exit', async () => {
    const { id, issSeq } = await seedIssue();

    const message = await refusalFrom(() =>
      harness.db.execute(sql`UPDATE issues SET status = 'closed' WHERE id = ${id}`),
    );

    expect(message).toContain('ISS-1108');
    expect(message).toContain(id);
    expect(message).toContain(`ISS-${issSeq}`);
    expect(message).toContain('merged_at');
    expect(message).toContain('dropped');
    expect(await statusOf(id)).toBe('in_progress');
  });

  it('refuses a row created `closed` with no merged_at, so "no way in" means every way', async () => {
    const message = await refusalFrom(() =>
      harness.db.execute(sql`
        INSERT INTO issues (id, project_id, iss_seq, created_by_id, title, description, status)
        VALUES (${randomUUID()}, ${projectId}, ${++seq}, ${userId}, 'born closed', 'fixture', 'closed')
      `),
    );

    expect(message).toContain('ISS-1108');
    expect(message).toContain('dropped');
  });

  it('refuses the close even when the same statement sets other columns', async () => {
    const { id } = await seedIssue();

    const message = await refusalFrom(() =>
      harness.db.execute(
        sql`UPDATE issues SET title = 'renamed on the way out', status = 'closed' WHERE id = ${id}`,
      ),
    );

    expect(message).toContain('ISS-1108');
    expect(await statusOf(id)).toBe('in_progress');
  });

  it('lets the same write through once the row can show it shipped', async () => {
    const { id } = await seedIssue({ merged: true });

    await harness.db.execute(sql`UPDATE issues SET status = 'closed' WHERE id = ${id}`);

    expect(await statusOf(id)).toBe('closed');
  });

  it('leaves `dropped` alone, which is the exit for work that will not happen', async () => {
    const { id } = await seedIssue();

    await harness.db.execute(sql`UPDATE issues SET status = 'dropped' WHERE id = ${id}`);

    expect(await statusOf(id)).toBe('dropped');
  });
});

describe('migration 0290 is decided by the rows it finds (ISS-1108)', () => {
  it('counts them, names one, and changes nothing', async () => {
    await dropTheRule();
    try {
      const { id, issSeq } = await seedIssue({ status: 'closed' });

      const message = await refusalFrom(runMigration);

      expect(message).toContain('ISS-1108');
      expect(message).toContain('1 issue row(s)');
      expect(message).toContain(id);
      expect(message).toContain(`ISS-${issSeq}`);
      expect(message).toContain('dropped');
      // Named and left standing: not stamped, not dropped, not cleaned away.
      const rows = await harness.db.execute<{ status: string; merged_at: Date | null }>(
        sql`SELECT status, merged_at FROM issues WHERE id = ${id}`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'closed', merged_at: null });
    } finally {
      await harness.db.execute(
        sql`DELETE FROM issues WHERE status = 'closed' AND merged_at IS NULL`,
      );
      await runMigration();
    }
  });

  it('installs the rule where it finds nothing it cannot represent', async () => {
    await dropTheRule();
    await seedIssue({ status: 'closed', merged: true });

    await runMigration();

    const { id } = await seedIssue();
    expect(
      await refusalFrom(() =>
        harness.db.execute(sql`UPDATE issues SET status = 'closed' WHERE id = ${id}`),
      ),
    ).toContain('ISS-1108');
  });
});
