/**
 * The operator resume, against real Postgres.
 *
 * Two things here cannot be checked with a mocked db: the CAS on
 * `status='held'` (the only thing standing between two operators and a
 * double-enqueue) and the `issue_intervention_events` label, which migration
 * 0181 changed from a hardcoded `manual_cancel` to the row's own action. The
 * second is the whole reason the migration exists — a resume charted as a
 * cancel reads as an operator killing work they actually rescued.
 */

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

vi.mock('../../src/pipeline/wedge.js', () => ({
  emitPipelineWedge: async () => undefined,
  resolvePipelineWedge: async () => 0,
}));

const enqueueMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../../src/jobs/enqueue.js', () => ({
  enqueueJob: (...a: unknown[]) => enqueueMock(...a),
  enqueueReconcileJob: (...a: unknown[]) => enqueueMock(...a),
}));

vi.mock('../../src/ws/server.js', () => ({ roomManager: { publish: () => undefined } }));
vi.mock('../../src/issues/pipeline-health.js', () => ({
  publishPipelineHealthChanged: async () => undefined,
}));

type Mods = {
  resumeHeldJob: typeof import('../../src/jobs/resume-job.js').resumeHeldJob;
};

describe('held job resume E2E', () => {
  let harness: TestDatabase;
  let mods: Mods;
  let projectId: string;
  let ownerId: string;
  let runId: string;

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

    mods = (await import('../../src/jobs/resume-job.js')) as unknown as Mods;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    enqueueMock.mockClear();
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    const project = await createTestProject(harness.db, owner.id);
    projectId = project.id;
    runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, NULL, 'system', 'running', now())
    `);
  });

  async function insertHeldJob(reason = 'non_retryable_terminal'): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, created_by, type, status, payload,
                        failure_kind, failure_reason, queued_at)
      VALUES (
        ${id}, ${projectId}, ${runId}, ${ownerId}, 'code', 'held',
        ${JSON.stringify({
          __hold: { reason, heldAt: '2026-08-14T06:00:00.000Z', autoRelease: false },
          requiredCapabilities: { git: true },
        })}::jsonb,
        'infra', ${reason}, now() - interval '9 hours'
      )
    `);
    return id;
  }

  const opts = {
    actorUserId: '',
    reason: 'workspace re-provisioned by hand',
    source: 'rest' as const,
  };

  it('flips held to queued, clears the verdict and keeps the rest of the payload', async () => {
    const jobId = await insertHeldJob();

    const res = await mods.resumeHeldJob(jobId, { ...opts, actorUserId: ownerId });

    expect(res.heldReason).toBe('non_retryable_terminal');
    const [row] = await harness.db.execute<{
      status: string;
      failure_reason: string | null;
      failure_kind: string | null;
      payload: Record<string, unknown>;
    }>(sql`SELECT status, failure_reason, failure_kind, payload FROM jobs WHERE id = ${jobId}`);
    expect(row?.status).toBe('queued');
    expect(row?.failure_reason).toBeNull();
    expect(row?.failure_kind).toBeNull();
    expect(row?.payload.requiredCapabilities).toEqual({ git: true });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  // cm:guard the second resume must lose, and losing must mean NO enqueue — this is the real race (two operators, or one racing releaseHeldJobs), and a mocked db cannot be wrong about a CAS it never runs
  it('a second concurrent resume loses the CAS and enqueues nothing', async () => {
    const jobId = await insertHeldJob();

    const results = await Promise.allSettled([
      mods.resumeHeldJob(jobId, { ...opts, actorUserId: ownerId }),
      mods.resumeHeldJob(jobId, { ...opts, actorUserId: ownerId }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const events = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM job_events WHERE job_id = ${jobId} AND kind = 'intervention'`,
    );
    expect(Number(events[0]?.n)).toBe(1);
  });

  it('refuses a job that is not held and leaves it alone', async () => {
    const jobId = await insertHeldJob();
    await harness.db.execute(sql`UPDATE jobs SET status = 'running' WHERE id = ${jobId}`);

    await expect(mods.resumeHeldJob(jobId, { ...opts, actorUserId: ownerId })).rejects.toThrow(
      /not held/,
    );
    const [row] = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM jobs WHERE id = ${jobId}`,
    );
    expect(row?.status).toBe('running');
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  // cm:guard migration 0181's whole point — before it, `issue_intervention_events` hardcoded `manual_cancel` for every `kind='intervention'` row, so this resume would have been charted as a cancel in VISION §1 metric ②
  it('appears in the interventions view as manual_resume, not manual_cancel', async () => {
    const jobId = await insertHeldJob();
    await mods.resumeHeldJob(jobId, { ...opts, actorUserId: ownerId });

    const rows = await harness.db.execute<{ source: string; detail: string }>(sql`
      SELECT source, detail FROM issue_intervention_events WHERE source LIKE 'manual_%'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('manual_resume');
    expect(rows[0]?.detail).toBe('workspace re-provisioned by hand');
  });

  // cm:guard a hand-inserted row with no `action` must keep reading as a cancel — 0117-era rows are exactly that shape, and relabelling history is how a migration turns a metric into a discontinuity
  it('still labels an action-less intervention row manual_cancel', async () => {
    const jobId = await insertHeldJob();
    await harness.db.execute(sql`
      INSERT INTO job_events (job_id, kind, data, seq)
      VALUES (${jobId}, 'intervention', ${JSON.stringify({ reason: 'legacy row' })}::jsonb, 1)
    `);

    const rows = await harness.db.execute<{ source: string }>(sql`
      SELECT source FROM issue_intervention_events WHERE source LIKE 'manual_%'
    `);
    expect(rows.map((r) => r.source)).toEqual(['manual_cancel']);
  });
});
