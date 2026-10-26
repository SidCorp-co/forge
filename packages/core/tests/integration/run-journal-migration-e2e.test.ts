/**
 * ISS-1133 — migration 0333, against a real Postgres.
 *
 * A database migrated to head holds `run_journal` and none of what it replaced. The shipped DO
 * block, replayed against stand-ins of the two dropped tables, copies no row, counts what it drops
 * (its open phases apart), and removes the schedule of the hourly jobs backfill that leaves with it.
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
  new URL('../../drizzle/migrations/0333_one_record_of_what_a_run_did.sql', import.meta.url),
);

let harness: TestDatabase;

/** Every statement of the shipped file, in order, as the migrator runs them. */
function everyStatement(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** The DO block of the shipped file, so a rewrite stops this test rather than proving a copy. */
function dropBlock(): string {
  const source = readFileSync(MIGRATION, 'utf8');
  const hit = source.split('--> statement-breakpoint').find((s) => s.includes('DO $$'));
  if (!hit) {
    throw new Error(
      '0333_one_record_of_what_a_run_did.sql no longer holds a DO block. This test reads the shipped file rather than a copy, so a rewrite stops it instead of silently proving something that will not deploy.',
    );
  }
  return hit.slice(hit.indexOf('DO $$'));
}

beforeAll(async () => {
  harness = await setupTestDatabase({
    own: 'creates tables and a pgboss schema to replay a migration',
  });
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

async function one<T>(query: ReturnType<typeof sql>): Promise<T> {
  const rows = (await harness.db.execute(query)) as unknown as T[];
  return rows[0] as T;
}

describe('a database migrated to head (criterion 9)', () => {
  it('holds run_journal and none of the tables or the view it replaced', async () => {
    expect(
      await one(sql`
        SELECT to_regclass('public.run_journal') IS NOT NULL AS has_journal,
               to_regclass('public.phase_journal') IS NULL AS no_phases,
               to_regclass('public.issue_step_contexts') IS NULL AS no_contexts,
               to_regclass('public.phase_step_durations') IS NULL AS no_view,
               to_regclass('public.run_journal_run_phase_attempt_idx') IS NOT NULL AS one_per_attempt`),
    ).toEqual({
      has_journal: true,
      no_phases: true,
      no_contexts: true,
      no_view: true,
      one_per_attempt: true,
    });
  });
});

describe('the drop, replayed against the tables it drops (criteria 10, 20)', () => {
  let notices: string[];
  let client: postgres.Sql;
  let ownSchedule: boolean;

  beforeEach(async () => {
    await truncateAll(harness.db);
    notices = [];
    client = postgres(harness.url, { max: 1, onnotice: (n) => notices.push(n.message ?? '') });
    await harness.db.execute(sql`CREATE TABLE phase_journal (run_id uuid, ended_at timestamptz)`);
    await harness.db.execute(sql`CREATE TABLE issue_step_contexts (issue_id uuid)`);
    const held = await one<{ held: boolean }>(
      sql`SELECT to_regclass('pgboss.schedule') IS NOT NULL AS held`,
    );
    if (held.held) {
      throw new Error(
        'this database already holds pg-boss tables, so the stand-in schedule this test plants would be the real one. Run it on a database the integration harness migrated and nothing started a queue on.',
      );
    }
    ownSchedule = true;
    await harness.db.execute(sql`CREATE SCHEMA pgboss`);
    await harness.db.execute(sql`CREATE TABLE pgboss.schedule (name text PRIMARY KEY)`);
  });

  afterEach(async () => {
    await client.end({ timeout: 5 });
    await harness.db.execute(sql`DROP VIEW IF EXISTS phase_step_durations`);
    await harness.db.execute(sql`DROP TABLE IF EXISTS phase_journal`);
    await harness.db.execute(sql`DROP TABLE IF EXISTS issue_step_contexts`);
    if (ownSchedule) await harness.db.execute(sql`DROP SCHEMA IF EXISTS pgboss CASCADE`);
  });

  it('copies no row, counts what it drops with the open phases apart, and unschedules the backfill', async () => {
    const owner = await createTestUser(harness.db);
    await createTestProject(harness.db, owner.id);
    await harness.db.execute(sql`
      INSERT INTO phase_journal (run_id, ended_at)
      VALUES (gen_random_uuid(), now()), (gen_random_uuid(), now()), (gen_random_uuid(), NULL)`);
    await harness.db.execute(sql`
      INSERT INTO issue_step_contexts (issue_id) VALUES (gen_random_uuid()), (gen_random_uuid())`);
    await harness.db.execute(sql`
      INSERT INTO pgboss.schedule (name) VALUES ('phase-journal-backfill'), ('retention-sweeper')`);

    await client.unsafe(dropBlock());

    expect(notices.join('\n')).toContain(
      'ISS-1133: dropping 3 phase journal rows (1 of them open, so a session resuming that run restarts at phase 1) and 2 step handoffs; none is carried into run_journal',
    );
    expect(await one(sql`SELECT count(*)::int AS n FROM run_journal`)).toEqual({ n: 0 });
    const left = (await harness.db.execute(
      sql`SELECT name FROM pgboss.schedule ORDER BY name`,
    )) as unknown as Array<{ name: string }>;
    expect(left.map((r) => r.name)).toEqual(['retention-sweeper']);
  });

  it('runs on a database where pg-boss has made no tables yet', async () => {
    await harness.db.execute(sql`DROP SCHEMA pgboss CASCADE`);
    await client.unsafe(dropBlock());
    expect(notices.join('\n')).toContain('dropping 0 phase journal rows');
  });

  it('runs every statement of the file over populated predecessors: drops them, copies nothing, and builds run_journal', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const run = (
      (await harness.db.execute(sql`
        INSERT INTO pipeline_runs (project_id, kind, status) VALUES (${project.id}, 'system', 'completed')
        RETURNING id`)) as unknown as Array<{ id: string }>
    )[0]?.id;
    await harness.db.execute(sql`DROP TABLE run_journal`);
    await harness.db.execute(sql`
      ALTER TABLE phase_journal ADD COLUMN phase text, ADD COLUMN started_at timestamptz,
        ADD FOREIGN KEY (run_id) REFERENCES pipeline_runs(id) ON DELETE CASCADE`);
    await harness.db.execute(sql`
      CREATE VIEW phase_step_durations AS
        SELECT run_id, phase AS step, ended_at - started_at AS took FROM phase_journal`);
    await harness.db.execute(sql`
      INSERT INTO phase_journal (run_id, phase, started_at, ended_at)
      VALUES (${run}, 'plan', now(), now()), (${run}, 'drive', now(), NULL)`);
    await harness.db.execute(sql`
      INSERT INTO issue_step_contexts (issue_id) VALUES (gen_random_uuid())`);
    await harness.db.execute(sql`
      INSERT INTO pgboss.schedule (name) VALUES ('phase-journal-backfill')`);

    for (const statement of everyStatement()) await client.unsafe(statement);

    expect(notices.join('\n')).toContain(
      'dropping 2 phase journal rows (1 of them open, so a session resuming that run restarts at phase 1) and 1 step handoffs',
    );
    expect(
      await one(sql`
        SELECT to_regclass('public.phase_journal') IS NULL AS no_phases,
               to_regclass('public.issue_step_contexts') IS NULL AS no_contexts,
               to_regclass('public.phase_step_durations') IS NULL AS no_view,
               to_regclass('public.run_journal_run_phase_attempt_idx') IS NOT NULL AS one_per_attempt,
               (SELECT count(*)::int FROM run_journal) AS copied,
               (SELECT count(*)::int FROM pgboss.schedule) AS scheduled`),
    ).toEqual({
      no_phases: true,
      no_contexts: true,
      no_view: true,
      one_per_attempt: true,
      copied: 0,
      scheduled: 0,
    });
  });
});
