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
 * ISS-654 — the second phantom shape: an issue run that never grew a job.
 *
 * `reapOrphanedOneShotRuns` reaps the job-less shape for `system`/`interactive`
 * only, and `reapConcludedRuns` requires a job to judge an outcome from, so an
 * issue run whose dispatch never landed stayed `running` for as long as its
 * issue stayed open and counted as live work no box was doing.
 */
describe('reapJoblessRuns predicate E2E (ISS-654)', () => {
  let harness: TestDatabase;
  let mods: { reapJoblessRuns: (now?: Date) => Promise<{ reaped: number }> };
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

  let seq = 900;

  async function seedRun(
    opts: { kind?: string; status?: string; startedMinutesAgo?: number } = {},
  ): Promise<string> {
    const kind = opts.kind ?? 'issue';
    // cm:guard `pipeline_runs_issue_kind_chk` binds issue_id to kind — a `system`/`interactive` run may not carry one, so this seed cannot pass the same issue for every kind.
    let issueId: string | null = null;
    if (kind === 'issue') {
      issueId = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
        VALUES (${issueId}, ${projectId}, ${seq++}, 'jobless run', 'in_progress', 'medium', ${ownerId})
      `);
    }
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (
        ${runId}, ${projectId}, ${issueId}, ${kind}, ${opts.status ?? 'running'},
        now() - make_interval(mins => ${opts.startedMinutesAgo ?? 5000})
      )
    `);
    return runId;
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

  it.each(['running', 'paused'])('closes a quiet job-less `%s` issue run', async (status) => {
    const runId = await seedRun({ status });

    const res = await mods.reapJoblessRuns(new Date());

    expect(res.reaped).toBe(1);
    expect(await runStatus(runId)).toBe('cancelled');
  });

  // cm:guard the outcome of a run that never ran anything is `cancelled`, never `failed` — a fabricated failure lands in every success-rate metric that reads run outcomes.
  it('closes as `cancelled` when nothing ever ran, `failed` when a session failed', async () => {
    const nothing = await seedRun();
    const failed = await seedRun();
    await seedSession(failed, 'failed');

    expect((await mods.reapJoblessRuns(new Date())).reaped).toBe(2);
    expect(await runStatus(nothing)).toBe('cancelled');
    expect(await runStatus(failed)).toBe('failed');
  });

  it('closes as `completed` when a session under it completed and none failed', async () => {
    const runId = await seedRun();
    await seedSession(runId, 'completed');

    expect((await mods.reapJoblessRuns(new Date())).reaped).toBe(1);
    expect(await runStatus(runId)).toBe('completed');
  });

  it('leaves a job-less run holding a live session', async () => {
    const runId = await seedRun();
    await seedSession(runId, 'running');

    const res = await mods.reapJoblessRuns(new Date());

    expect(res.reaped).toBe(0);
    expect(await runStatus(runId)).toBe('running');
  });

  // cm:guard an issue run is opened BEFORE its first job is enqueued, so the quiet window is what stands between this pass and a run that is about to be dispatched into.
  it('leaves a job-less run younger than the quiet window', async () => {
    const runId = await seedRun({ startedMinutesAgo: 5 });

    const res = await mods.reapJoblessRuns(new Date());

    expect(res.reaped).toBe(0);
    expect(await runStatus(runId)).toBe('running');
  });

  it.each(['system', 'interactive'])(
    'leaves a job-less `%s` run to reapOrphanedOneShotRuns',
    async (kind) => {
      const runId = await seedRun({ kind });

      const res = await mods.reapJoblessRuns(new Date());

      expect(res.reaped).toBe(0);
      expect(await runStatus(runId)).toBe('running');
    },
  );

  it('leaves an issue run that HAS a job to reapConcludedRuns', async () => {
    const runId = await seedRun();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, type, status, created_by, created_at, finished_at)
      VALUES (${randomUUID()}, ${projectId}, ${runId}, 'drive', 'done', ${ownerId},
              now() - interval '10 days', now() - interval '10 days')
    `);

    const res = await mods.reapJoblessRuns(new Date());

    expect(res.reaped).toBe(0);
    expect(await runStatus(runId)).toBe('running');
  });

  it('is idempotent — a second tick finds nothing', async () => {
    await seedRun();

    expect((await mods.reapJoblessRuns(new Date())).reaped).toBe(1);
    expect((await mods.reapJoblessRuns(new Date())).reaped).toBe(0);
  });
});
