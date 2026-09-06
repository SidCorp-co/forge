import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

vi.mock('../../src/pipeline/wedge.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  emitPipelineWedge: async () => undefined,
  resolvePipelineWedge: async () => 0,
}));

/**
 * ISS-923 — the inverse orphan direction, proved against real SQL.
 *
 * `reapConcludedRuns` is almost entirely a WHERE clause: which runs it admits
 * and which it leaves alone IS the behaviour. A mocked `db.execute` returns
 * whatever the test feeds it, so `runs-concluded.test.ts` proves the outcome
 * mapping and the error isolation but is NO evidence about the predicate. Only
 * real Postgres is, and the predicate is where every way this pass could do
 * damage lives — closing a run that still has work in flight, or one whose
 * next job is a heartbeat away.
 */
describe('reapConcludedRuns predicate E2E (ISS-923)', () => {
  let harness: TestDatabase;
  let mods: {
    reapConcludedRuns: (now?: Date) => Promise<{ reaped: number }>;
  };
  let projectId: string;
  let ownerId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';

    mods = (await import('../../src/pipeline/runs-concluded.js')) as unknown as typeof mods;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    projectId = (await createTestProject(harness.db, owner.id)).id;
  });

  let seq = 700;

  async function seedIssue(): Promise<string> {
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (${issueId}, ${projectId}, ${seq++}, 'concluded run', 'in_progress', 'medium', ${ownerId})
    `);
    return issueId;
  }

  async function seedRun(runStatus: 'running' | 'paused' = 'running'): Promise<string> {
    const issueId = await seedIssue();
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', ${runStatus}, now() - interval '30 days')
    `);
    return runId;
  }

  /** `quietMinutes` back from now — the clock the predicate reads. */
  async function seedJob(runId: string, status: string, quietMinutes: number): Promise<string> {
    const jobId = randomUUID();
    const finished =
      status === 'queued' || status === 'dispatched' || status === 'running' || status === 'held';
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, type, status, created_by, created_at, finished_at)
      VALUES (
        ${jobId}, ${projectId}, ${runId}, 'drive', ${status}, ${ownerId},
        now() - make_interval(mins => ${quietMinutes + 1}),
        ${finished ? null : sql`now() - make_interval(mins => ${quietMinutes})`}
      )
    `);
    return jobId;
  }

  async function seedSession(runId: string, status: string): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, status)
      VALUES (${randomUUID()}, ${projectId}, ${runId}, ${status})
    `);
  }

  async function runStatus(runId: string): Promise<string> {
    const rows = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM pipeline_runs WHERE id = ${runId}`,
    );
    return rows[0]?.status ?? 'missing';
  }

  it.each([
    ['done', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ])('closes a quiet run whose last job is `%s` as `%s`', async (jobStatus, expected) => {
    const runId = await seedRun();
    await seedJob(runId, jobStatus, 90);

    const res = await mods.reapConcludedRuns(new Date());

    expect(res.reaped).toBe(1);
    expect(await runStatus(runId)).toBe(expected);
  });

  it('takes the outcome from the LAST job, not from an earlier one', async () => {
    const runId = await seedRun();
    await seedJob(runId, 'done', 200);
    await seedJob(runId, 'failed', 90);

    const res = await mods.reapConcludedRuns(new Date());

    expect(res.reaped).toBe(1);
    expect(await runStatus(runId)).toBe('failed');
  });

  it('closes `completed` when a failed job was followed by a successful one', async () => {
    const runId = await seedRun();
    await seedJob(runId, 'failed', 200);
    await seedJob(runId, 'done', 90);

    const res = await mods.reapConcludedRuns(new Date());

    expect(res.reaped).toBe(1);
    expect(await runStatus(runId)).toBe('completed');
  });

  // cm:guard the quiet window is what stands between this pass and a run whose next job is seconds away — remove it and this assertion is the one that goes red.
  it('leaves a run whose last job went terminal inside the quiet window', async () => {
    const runId = await seedRun();
    await seedJob(runId, 'done', 5);

    const res = await mods.reapConcludedRuns(new Date());

    expect(res.reaped).toBe(0);
    expect(await runStatus(runId)).toBe('running');
  });

  // cm:guard the pass must read the CALLER's clock, not SQL's `now()` — the parameter is otherwise
  // decoration, and the mistake is invisible because the default argument makes it behave correctly.
  it('reads the quiet window from the `now` it is given, not the DB clock', async () => {
    const runId = await seedRun();
    await seedJob(runId, 'done', 5);

    // cm:why 5 minutes quiet is inside the window from real now and outside it from an hour ahead — the same row, two clocks, which is the only shape that separates the two readings.
    expect((await mods.reapConcludedRuns(new Date())).reaped).toBe(0);
    const later = new Date(Date.now() + 61 * 60_000);
    expect((await mods.reapConcludedRuns(later)).reaped).toBe(1);
    expect(await runStatus(runId)).toBe('completed');
  });

  // cm:guard the window is per-RUN, not per-job: one recent job holds the whole run open.
  it('leaves a run with one old job and one recent job', async () => {
    const runId = await seedRun();
    await seedJob(runId, 'done', 500);
    await seedJob(runId, 'done', 2);

    const res = await mods.reapConcludedRuns(new Date());

    expect(res.reaped).toBe(0);
    expect(await runStatus(runId)).toBe('running');
  });

  it.each(['queued', 'dispatched', 'running', 'held'])(
    'leaves a run with a `%s` job however old',
    async (jobStatus) => {
      const runId = await seedRun();
      await seedJob(runId, 'done', 5000);
      await seedJob(runId, jobStatus, 5000);

      const res = await mods.reapConcludedRuns(new Date());

      expect(res.reaped).toBe(0);
      expect(await runStatus(runId)).toBe('running');
    },
  );

  // cm:edge contract -> packages/core/src/pipeline/runs-concluded.ts — a job-less run belongs to `reapJoblessRuns`, never to this pass; one run answering to two reapers with different outcome rules is the shape both guards exist to prevent.
  it('leaves a run with no jobs at all', async () => {
    const runId = await seedRun();

    const res = await mods.reapConcludedRuns(new Date());

    expect(res.reaped).toBe(0);
    expect(await runStatus(runId)).toBe('running');
  });

  // cm:guard ISS-654 narrowed this from "never touch a paused run" to "never touch a paused run that could still be resumed into work" — a live session is what makes the pause a hold rather than a phantom, and this pair is the whole distinction.
  it('leaves a `paused` run holding a live session alone', async () => {
    const runId = await seedRun('paused');
    await seedJob(runId, 'done', 5000);
    await seedSession(runId, 'running');

    const res = await mods.reapConcludedRuns(new Date());

    expect(res.reaped).toBe(0);
    expect(await runStatus(runId)).toBe('paused');
  });

  it('closes a `paused` run whose jobs are all terminal and whose sessions are all dead', async () => {
    const runId = await seedRun('paused');
    await seedJob(runId, 'done', 5000);
    await seedSession(runId, 'failed');

    const res = await mods.reapConcludedRuns(new Date());

    expect(res.reaped).toBe(1);
    expect(await runStatus(runId)).toBe('completed');
  });

  it('closes a `paused` run carrying no session at all', async () => {
    const runId = await seedRun('paused');
    await seedJob(runId, 'failed', 5000);

    const res = await mods.reapConcludedRuns(new Date());

    expect(res.reaped).toBe(1);
    expect(await runStatus(runId)).toBe('failed');
  });

  it('is idempotent — a second tick finds nothing', async () => {
    const runId = await seedRun();
    await seedJob(runId, 'done', 90);

    expect((await mods.reapConcludedRuns(new Date())).reaped).toBe(1);
    expect((await mods.reapConcludedRuns(new Date())).reaped).toBe(0);
    expect(await runStatus(runId)).toBe('completed');
  });

  it('drains a backlog of many leaked runs in one tick', async () => {
    const runIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const runId = await seedRun();
      await seedJob(runId, 'done', 90 + i);
      runIds.push(runId);
    }

    const res = await mods.reapConcludedRuns(new Date());

    expect(res.reaped).toBe(5);
    for (const id of runIds) expect(await runStatus(id)).toBe('completed');
  });
});
