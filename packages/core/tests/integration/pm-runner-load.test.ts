import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('readRunnerLoad', () => {
  let harness: TestDatabase;
  let readRunnerLoad: typeof import('../../src/pm/runner-load-service.js').readRunnerLoad;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';
    ({ readRunnerLoad } = await import('../../src/pm/runner-load-service.js'));
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    issSeq = 0;
  });

  async function insertRunner(projectId: string, name: string, type = 'claude-code') {
    const ownerRows = (await harness.db.execute(
      sql`SELECT created_by AS id FROM projects WHERE id = ${projectId}`,
    )) as unknown as Array<{ id: string }>;
    const device = await createTestDevice(harness.db, ownerRows[0]?.id as string);
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, capabilities, status, last_seen_at)
      VALUES (${id}, ${projectId}, ${type}, ${device.id}, ${name}, '{}'::jsonb, 'online', now())
    `);
    return id;
  }

  let issSeq = 0;

  async function insertRun(projectId: string, status = 'running'): Promise<string> {
    const issueId = randomUUID();
    issSeq += 1;
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (${issueId}, ${projectId}, ${issSeq}, ${`Issue ${issSeq}`}, 'in_progress', 'medium',
        (SELECT created_by FROM projects WHERE id = ${projectId}))
    `);
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', ${status}, now())
    `);
    return runId;
  }

  async function insertJob(
    projectId: string,
    runnerId: string,
    status: string,
    runStatus = 'running',
  ) {
    const runId = await insertRun(projectId, runStatus);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, type, status, runner_id, pipeline_run_id, payload, queued_at, created_by)
      VALUES (${randomUUID()}, ${projectId}, 'code', ${status}, ${runnerId}, ${runId}, '{}'::jsonb, now(),
        (SELECT created_by FROM projects WHERE id = ${projectId}))
    `);
  }

  async function seedProject() {
    const user = await createTestUser(harness.db);
    return createTestProject(harness.db, user.id);
  }

  it('counts each runner its own jobs, and only the occupying ones', async () => {
    const project = await seedProject();
    const busy = await insertRunner(project.id, 'busy');
    const idle = await insertRunner(project.id, 'idle', 'claude-code');

    await insertJob(project.id, busy, 'running');
    await insertJob(project.id, busy, 'dispatched');
    await insertJob(project.id, busy, 'done');
    await insertJob(project.id, busy, 'queued');
    await insertJob(project.id, idle, 'failed');

    const load = await readRunnerLoad(project.id);
    const byId = new Map(load.map((r) => [r.id, r]));

    expect(load).toHaveLength(2);
    expect(byId.get(busy)?.inFlight).toBe(2);
    expect(byId.get(idle)?.inFlight).toBe(0);
    for (const r of load) expect(r).not.toHaveProperty('capacity');
  });

  it('does not hand one runner another runner load', async () => {
    const project = await seedProject();
    const a = await insertRunner(project.id, 'a');
    const b = await insertRunner(project.id, 'b', 'claude-code');

    await insertJob(project.id, a, 'running');
    await insertJob(project.id, b, 'running');
    await insertJob(project.id, b, 'running');

    const byId = new Map((await readRunnerLoad(project.id)).map((r) => [r.id, r]));
    expect(byId.get(a)?.inFlight).toBe(1);
    expect(byId.get(b)?.inFlight).toBe(2);
  });

  it('leaves another project runners out entirely', async () => {
    const mine = await seedProject();
    const theirs = await seedProject();
    const ours = await insertRunner(mine.id, 'ours');
    const alien = await insertRunner(theirs.id, 'alien');
    await insertJob(theirs.id, alien, 'running');

    const load = await readRunnerLoad(mine.id);
    expect(load.map((r) => r.id)).toEqual([ours]);
  });

  it('does not count a job whose pipeline run has already gone terminal', async () => {
    const project = await seedProject();
    const runner = await insertRunner(project.id, 'r');

    await insertJob(project.id, runner, 'running', 'running');
    await insertJob(project.id, runner, 'running', 'paused');

    await harness.db.execute(
      sql`ALTER TABLE jobs DISABLE TRIGGER trg_jobs_no_active_under_terminal_run`,
    );
    try {
      await insertJob(project.id, runner, 'running', 'completed');
      await insertJob(project.id, runner, 'dispatched', 'failed');
    } finally {
      await harness.db.execute(
        sql`ALTER TABLE jobs ENABLE TRIGGER trg_jobs_no_active_under_terminal_run`,
      );
    }

    const [row] = await readRunnerLoad(project.id);
    expect(row?.inFlight).toBe(2);
  });

  it('answers an empty project without touching jobs', async () => {
    const project = await seedProject();
    await expect(readRunnerLoad(project.id)).resolves.toEqual([]);
  });
});
