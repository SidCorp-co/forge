import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('ISS-826 retry_rescues', () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    // The detector imports `db/client.js`, which validates the whole env at module load.
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
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function insertRun(projectId: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
      VALUES (${id}, ${projectId}, 'system', 'completed', now())
    `);
    return id;
  }

  async function seedJob(input: {
    projectId: string;
    pipelineRunId: string;
    status: 'done' | 'failed';
    retryOf?: string;
    failureKind?: 'infra' | 'timeout';
    failureReason?: string;
  }): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (
        id, project_id, pipeline_run_id, type, status, payload, created_by, retry_of,
        failure_kind, failure_reason, finished_at
      )
      VALUES (
        ${id}, ${input.projectId}, ${input.pipelineRunId}, 'code', ${input.status}, '{}'::jsonb,
        (SELECT created_by FROM projects WHERE id = ${input.projectId}),
        ${input.retryOf ?? null}, ${input.failureKind ?? null}, ${input.failureReason ?? null}, now()
      )
    `);
    return id;
  }

  it('counts a rescued chain once and attributes it to its original failure reason', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const runId = await insertRun(project.id);
    const original = await seedJob({
      projectId: project.id,
      pipelineRunId: runId,
      status: 'failed',
      failureKind: 'infra',
      failureReason: 'hooks_path',
    });
    const secondFailure = await seedJob({
      projectId: project.id,
      pipelineRunId: runId,
      status: 'failed',
      retryOf: original,
      failureKind: 'timeout',
      failureReason: 'transient_timeout',
    });
    await seedJob({
      projectId: project.id,
      pipelineRunId: runId,
      status: 'done',
      retryOf: secondFailure,
    });

    const rows = await harness.db.execute<{
      failure_kind: string | null;
      failure_reason: string;
    }>(sql`
      SELECT failure_kind, failure_reason
      FROM retry_rescues
      WHERE project_id = ${project.id}
    `);

    expect(rows).toEqual([{ failure_kind: 'infra', failure_reason: 'hooks_path' }]);
  });

  // ISS-1063 — `retry_rescue_threshold` is a condition declaring `pendingEvaluations: 2`,
  // so the record this detector writes on its first sighting is delivered to nobody until a
  // LATER emission of the same identity promotes it. The detector skipped on existence
  // alone, so that later emission never happened: the alarm wrote a pending row every
  // window and no human was ever told, which is green on every tick and silent in the one
  // place it matters. This walks three evaluations through the real detector.
  it('an alarm crossing the threshold is delivered on its second evaluation, once', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const runId = await insertRun(project.id);
    for (let i = 0; i < 5; i += 1) {
      const failed = await seedJob({
        projectId: project.id,
        pipelineRunId: runId,
        status: 'failed',
        failureKind: 'infra',
        failureReason: 'hooks_path',
      });
      await seedJob({
        projectId: project.id,
        pipelineRunId: runId,
        status: 'done',
        retryOf: failed,
      });
    }
    const { detectRetryRescueThresholds } = await import('../../src/pipeline/retry-rescue-alert.js');

    const first = await detectRetryRescueThresholds();
    expect(first).toEqual({ detected: 1, notified: 0 });
    const [pending] = (await harness.db.execute(
      sql`SELECT state FROM notifications WHERE type = 'retry_rescue_threshold'`,
    )) as unknown as [{ state: string }];
    expect(pending.state).toBe('pending');

    // Two sweeps later, the condition is still true.
    await harness.db.execute(
      sql`UPDATE notifications SET pending_since = now() - interval '10 minutes'`,
    );
    const second = await detectRetryRescueThresholds();
    expect(second).toEqual({ detected: 1, notified: 1 });

    // …and a third pass tells nobody a second time.
    const third = await detectRetryRescueThresholds();
    expect(third).toEqual({ detected: 1, notified: 0 });
    const [{ records, deliveries }] = (await harness.db.execute(sql`
      SELECT (SELECT count(*)::int FROM notifications WHERE type = 'retry_rescue_threshold') AS records,
             (SELECT count(*)::int FROM notification_deliveries) AS deliveries
    `)) as unknown as [{ records: number; deliveries: number }];
    expect({ records, deliveries }).toEqual({ records: 1, deliveries: 1 });
  });

  it('excludes unrescued chains and first-attempt successes', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const runId = await insertRun(project.id);
    await seedJob({
      projectId: project.id,
      pipelineRunId: runId,
      status: 'failed',
      failureKind: 'infra',
      failureReason: 'never_rescued',
    });
    await seedJob({ projectId: project.id, pipelineRunId: runId, status: 'done' });

    const rows = await harness.db.execute<{ rescues: number }>(sql`
      SELECT count(*)::int AS rescues
      FROM retry_rescues
      WHERE project_id = ${project.id}
    `);

    expect(Number(rows[0]?.rescues)).toBe(0);
  });
});
