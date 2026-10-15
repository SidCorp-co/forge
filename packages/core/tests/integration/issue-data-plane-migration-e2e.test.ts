/**
 * ISS-1132 — the shipped migration, run against rows the old schema left behind.
 *
 * The guard is read out of `0329_the_issue_data_plane_sheds_what_nothing_reads.sql` rather than
 * restated, because what has to hold is what the deploy will execute. A harness database is already
 * migrated to head, where the dropped relations are gone, so each case puts the old shape back, plants
 * the row, and runs the shipped block against it. What the block must do is abort naming the row where
 * the schema it is about to leave cannot represent that row, and count what it drops where it can.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const MIGRATION = fileURLToPath(
  new URL(
    '../../drizzle/migrations/0329_the_issue_data_plane_sheds_what_nothing_reads.sql',
    import.meta.url,
  ),
);

let harness: TestDatabase;

/** The guard block of the shipped file, so a rewrite stops this test rather than proving a copy. */
function guardBlock(): string {
  const source = readFileSync(MIGRATION, 'utf8');
  const hit = source.split('--> statement-breakpoint').find((s) => s.includes('DO $$'));
  if (!hit) {
    throw new Error(
      '0329_the_issue_data_plane_sheds_what_nothing_reads.sql no longer holds a DO block. This test reads the shipped file rather than a copy, so a rewrite stops it instead of silently proving something that will not deploy.',
    );
  }
  return hit.slice(hit.indexOf('DO $$'));
}

beforeAll(async () => {
  harness = await setupTestDatabase();
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

describe('a database migrated to head', () => {
  it('holds none of what the migration drops, and holds the single-row index', async () => {
    const rows = (await harness.db.execute(sql`
      SELECT to_regclass('public.tasks') IS NULL AS no_tasks,
             to_regclass('public.issue_attribute_defs') IS NULL AS no_defs,
             to_regclass('public.issue_step_contexts_verdict_idx') IS NULL AS no_verdict_idx,
             to_regclass('public.issue_attributes_single_row_uq') IS NOT NULL AS has_unique,
             NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'issue_step_contexts' AND column_name = 'verdict') AS no_verdict,
             NOT EXISTS (SELECT 1 FROM pg_constraint
                         WHERE conname = 'issue_attributes_key_issue_attribute_defs_key_fk') AS no_defs_fk
    `)) as unknown as Array<Record<string, boolean>>;
    expect(rows[0]).toEqual({
      no_tasks: true,
      no_defs: true,
      no_verdict_idx: true,
      has_unique: true,
      no_verdict: true,
      no_defs_fk: true,
    });
  });
});

describe('the guard, run against the schema the migration leaves', () => {
  let notices: string[];
  let client: postgres.Sql;

  beforeEach(async () => {
    await truncateAll(harness.db);
    notices = [];
    client = postgres(harness.url, { max: 1, onnotice: (n) => notices.push(n.message ?? '') });
    await harness.db.execute(sql`
      CREATE TABLE tasks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        issue_id uuid NOT NULL,
        title text NOT NULL DEFAULT 't',
        priority text NOT NULL DEFAULT 'none',
        assignee_id uuid,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    // ISS-1133 drops the table this block counts; the stand-in holds the columns the block reads.
    await harness.db.execute(sql`
      CREATE TABLE issue_step_contexts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL,
        issue_id uuid NOT NULL,
        pipeline_run_id uuid NOT NULL,
        kind text NOT NULL,
        step text,
        payload jsonb NOT NULL,
        verdict text
      )`);
    await harness.db.execute(sql`DROP INDEX issue_attributes_single_row_uq`);
  });

  afterEach(async () => {
    await client.end({ timeout: 5 });
    await harness.db.execute(sql`DROP TABLE IF EXISTS tasks`);
    await harness.db.execute(sql`DELETE FROM issue_attributes`);
    await harness.db.execute(sql`DROP TABLE IF EXISTS issue_step_contexts`);
    await harness.db.execute(sql`
      CREATE UNIQUE INDEX issue_attributes_single_row_uq ON issue_attributes (issue_id, key)
      WHERE key IN ('obligation_owner', 'obligation_carrier', 'delivered', 'delivered_of',
                    'human_required', 'irreversible_if_wrong', 'source')`);
  });

  async function anIssue(): Promise<{ issueId: string; userId: string; projectId: string }> {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const rows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO issues (project_id, title, created_by_id)
      VALUES (${project.id}, 'the subject', ${user.id}) RETURNING id
    `);
    return { issueId: (rows[0] as { id: string }).id, userId: user.id, projectId: project.id };
  }

  /** Everything one failed statement says, driver wrapper and cause together. */
  async function failureOf(): Promise<string> {
    try {
      await client.unsafe(guardBlock());
      return '';
    } catch (err) {
      const e = err as { message?: string; cause?: { message?: string } };
      return `${e.message ?? ''} ${e.cause?.message ?? ''}`;
    }
  }

  it('aborts naming a task that holds an assignee', async () => {
    const { issueId, userId } = await anIssue();
    const rows = await harness.db.execute<{ id: string }>(
      sql`INSERT INTO tasks (issue_id, assignee_id) VALUES (${issueId}, ${userId}) RETURNING id`,
    );
    const failure = await failureOf();
    expect(failure).toContain('ISS-1132');
    expect(failure).toContain((rows[0] as { id: string }).id);
    expect(failure).toContain(userId);
  });

  it('aborts naming a task that holds an order', async () => {
    const { issueId } = await anIssue();
    const rows = await harness.db.execute<{ id: string }>(
      sql`INSERT INTO tasks (issue_id, sort_order) VALUES (${issueId}, 3) RETURNING id`,
    );
    const failure = await failureOf();
    expect(failure).toContain((rows[0] as { id: string }).id);
    expect(failure).toContain('an order (3)');
  });

  it('aborts naming an issue that holds two rows of a single-row key', async () => {
    const { issueId } = await anIssue();
    await harness.db.execute(
      sql`INSERT INTO issue_attributes (issue_id, key, value_num) VALUES (${issueId}, 'delivered', 1), (${issueId}, 'delivered', 2)`,
    );
    const failure = await failureOf();
    expect(failure).toContain(issueId);
    expect(failure).toContain('2 rows');
    expect(failure).toContain('delivered');
  });

  it.each(['blocking', 'supersedes'])('aborts naming a row of the retired key %s', async (key) => {
    const { issueId } = await anIssue();
    const rows = await harness.db.execute<{ id: string }>(
      sql`INSERT INTO issue_attributes (issue_id, key, value_ref) VALUES (${issueId}, ${key}, ${issueId}) RETURNING id`,
    );
    const failure = await failureOf();
    expect(failure).toContain((rows[0] as { id: string }).id);
    expect(failure).toContain(key);
  });

  it('completes on tasks that use none of the withdrawn columns, and counts what it drops', async () => {
    const { issueId } = await anIssue();
    await harness.db.execute(sql`
      INSERT INTO tasks (issue_id, priority) VALUES (${issueId}, 'high'), (${issueId}, 'none'), (${issueId}, 'low')`);
    const project = await harness.db.execute<{ project_id: string }>(
      sql`SELECT project_id FROM issues WHERE id = ${issueId}`,
    );
    const projectId = (project[0] as { project_id: string }).project_id;
    const run = await harness.db.execute<{ id: string }>(
      sql`INSERT INTO pipeline_runs (project_id, issue_id, kind, status) VALUES (${projectId}, ${issueId}, 'issue', 'running') RETURNING id`,
    );
    await harness.db.execute(sql`
      INSERT INTO issue_step_contexts (project_id, issue_id, pipeline_run_id, kind, step, payload, verdict)
      VALUES (${projectId}, ${issueId}, ${(run[0] as { id: string }).id}, 'handoff', 'review', '{}'::jsonb, 'pass')`);
    expect(await failureOf()).toBe('');
    expect(notices.join('\n')).toContain(
      'dropping 3 tasks (of which 2 carried a priority, a withdrawn feature) and 1 typed step verdicts',
    );
  });
});
