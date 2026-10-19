/**
 * ISS-1229 — migration 0332, run against the rows the nine retired staged job types left behind.
 *
 * The block is read out of the shipped `.sql` rather than restated, because what has to hold is
 * what the deploy executes. The harness is already migrated to head, so each case plants the rows
 * and runs the shipped block against them: it must abort naming a retired job still in flight,
 * and otherwise delete the retired rows, count what it removed and leave every live row standing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LIVE_JOB_STATUSES } from '../../src/jobs/status-sets.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const MIGRATION = fileURLToPath(
  new URL('../../drizzle/migrations/0332_the_staged_job_types_leave.sql', import.meta.url),
);

let harness: TestDatabase;

/** The DO block of the shipped file, so a rewrite stops this test rather than proving a copy. */
function migrationBlock(): string {
  const source = readFileSync(MIGRATION, 'utf8');
  const at = source.indexOf('DO $$');
  if (at < 0) {
    throw new Error(
      '0332_the_staged_job_types_leave.sql no longer holds a DO block. This test reads the shipped file rather than a copy, so a rewrite stops it instead of silently proving something that will not deploy.',
    );
  }
  return source.slice(at);
}

beforeAll(async () => {
  harness = await setupTestDatabase();
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

type Scene = { projectId: string; issueId: string; userId: string; runId: string };

async function aScene(): Promise<Scene> {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  const issue = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id)
    VALUES (${project.id}, 'the subject', ${user.id}) RETURNING id
  `);
  const issueId = (issue[0] as { id: string }).id;
  const run = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO pipeline_runs (project_id, issue_id, kind, status)
    VALUES (${project.id}, ${issueId}, 'issue', 'running') RETURNING id
  `);
  return { projectId: project.id, issueId, userId: user.id, runId: (run[0] as { id: string }).id };
}

async function aJob(s: Scene, type: string, status: string): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO jobs (project_id, issue_id, pipeline_run_id, created_by, type, status, payload)
    VALUES (${s.projectId}, ${s.issueId}, ${s.runId}, ${s.userId}, ${type}, ${status},
            '{"promptString":"x"}'::jsonb)
    RETURNING id
  `);
  return (rows[0] as { id: string }).id;
}

async function events(jobId: string, n: number): Promise<void> {
  for (let seq = 1; seq <= n; seq++) {
    await harness.db.execute(
      sql`INSERT INTO job_events (job_id, kind, seq) VALUES (${jobId}, 'progress', ${seq})`,
    );
  }
}

async function usage(jobId: string): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO usage_records (source, model, recorded_at, job_id)
    VALUES ('test', 'sonnet', now(), ${jobId}) RETURNING id
  `);
  return (rows[0] as { id: string }).id;
}

async function count(query: ReturnType<typeof sql>): Promise<number> {
  const rows = await harness.db.execute<{ n: number }>(query);
  return Number((rows[0] as { n: number }).n);
}

describe('migration 0332', () => {
  let notices: string[];
  let client: postgres.Sql;

  beforeEach(async () => {
    await truncateAll(harness.db);
    // ISS-1133 drops the journal this block counts; the stand-in holds the one column it reads.
    await harness.db.execute(sql`CREATE TABLE phase_journal (job_id uuid)`);
    notices = [];
    client = postgres(harness.url, { max: 1, onnotice: (n) => notices.push(n.message ?? '') });
  });

  afterEach(async () => {
    await client.end({ timeout: 5 });
    await harness.db.execute(sql`DROP TABLE IF EXISTS phase_journal`);
  });

  /** Everything one failed statement says, driver wrapper and cause together. */
  async function failureOf(): Promise<string> {
    try {
      await client.unsafe(migrationBlock());
      return '';
    } catch (err) {
      const e = err as { message?: string; cause?: { message?: string } };
      return `${e.message ?? ''} ${e.cause?.message ?? ''}`;
    }
  }

  it.each([...LIVE_JOB_STATUSES])(
    'aborts naming a retired job still %s, and changes nothing',
    async (status) => {
      const s = await aScene();
      const finished = await aJob(s, 'code', 'done');
      await events(finished, 2);
      const inFlight = await aJob(s, 'fix', status);

      const failure = await failureOf();
      expect(failure).toContain('ISS-1229');
      expect(failure).toContain(inFlight);
      expect(failure).toContain(`retired staged type fix is still ${status}`);
      expect(await count(sql`SELECT count(*)::int AS n FROM jobs`)).toBe(2);
      expect(await count(sql`SELECT count(*)::int AS n FROM job_events`)).toBe(2);
    },
  );

  it('waits out a retired job another connection is still writing, then aborts naming it', async () => {
    const s = await aScene();
    const writer = postgres(harness.url, { max: 1 });
    try {
      const open = await writer.reserve();
      await open`BEGIN`;
      const rows = await open<Array<{ id: string }>>`
        INSERT INTO jobs (project_id, issue_id, pipeline_run_id, created_by, type, status, payload)
        VALUES (${s.projectId}, ${s.issueId}, ${s.runId}, ${s.userId}, 'fix', 'queued',
                '{"promptString":"x"}'::jsonb)
        RETURNING id`;
      const migrating = failureOf();
      await new Promise((r) => setTimeout(r, 400));
      await open`COMMIT`;
      open.release();
      const failure = await migrating;
      expect(failure).toContain((rows[0] as { id: string }).id);
      expect(failure).toContain('retired staged type fix is still queued');
      expect(await count(sql`SELECT count(*)::int AS n FROM jobs`)).toBe(1);
    } finally {
      await writer.end({ timeout: 5 });
    }
  });

  it('deletes every retired job with its events, unlinks its usage, keeps the live rows, and counts it', async () => {
    const s = await aScene();
    const code = await aJob(s, 'code', 'done');
    await events(code, 3);
    const codeUsage = await usage(code);
    const review = await aJob(s, 'review', 'failed');
    await events(review, 1);
    const live = await aJob(s, 'reconcile', 'done');
    await events(live, 2);
    const liveUsage = await usage(live);
    const runsBefore = await count(sql`SELECT count(*)::int AS n FROM pipeline_runs`);

    expect(await failureOf()).toBe('');

    expect(notices.join('\n')).toContain(
      'ISS-1229: deleted 2 jobs of the nine retired staged types with their 4 job events; unlinked 1 usage records, 0 phase journal entries and 0 feedback reports that named them, each kept',
    );
    const left = await harness.db.execute<{ id: string; type: string }>(
      sql`SELECT id, type FROM jobs ORDER BY type`,
    );
    expect(left).toEqual([{ id: live, type: 'reconcile' }]);
    expect(await count(sql`SELECT count(*)::int AS n FROM job_events`)).toBe(2);
    expect(await count(sql`SELECT count(*)::int AS n FROM pipeline_runs`)).toBe(runsBefore);
    const spend = await harness.db.execute<{ id: string; job_id: string | null }>(
      sql`SELECT id, job_id FROM usage_records ORDER BY job_id NULLS FIRST`,
    );
    expect(spend).toEqual([
      { id: codeUsage, job_id: null },
      { id: liveUsage, job_id: live },
    ]);
    expect(
      await count(sql`
        SELECT count(*)::int AS n FROM usage_records u
        WHERE u.job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = u.job_id)`),
    ).toBe(0);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM unaudited_transitions WHERE entity = 'job'`),
    ).toBe(0);
  });

  it('completes on a database holding no retired job, and says it deleted none', async () => {
    const s = await aScene();
    await aJob(s, 'smoke', 'queued');
    expect(await failureOf()).toBe('');
    expect(notices.join('\n')).toContain('ISS-1229: deleted 0 jobs');
    expect(await count(sql`SELECT count(*)::int AS n FROM jobs`)).toBe(1);
  });
});
