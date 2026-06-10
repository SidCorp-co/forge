import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// Phase 2.4-F1 integration — jobs CRUD row creation + dispatcher handler.
//
// Drives the dispatcher's handler function directly (not pg-boss) to keep the
// test hermetic. pg-boss lifecycle is already covered in queue/boss.test.ts.
//
// ISS-267: the legacy device dispatch path was removed; these tests seed an
// online `claude-code` runner so `selectRunnerForJob` resolves it.

type JobsMods = {
  handleDispatch: typeof import('../../src/jobs/dispatcher.js').handleDispatch;
};

describe('F1 jobs integration', () => {
  let harness: TestDatabase;
  let mods: JobsMods;

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

    const dispatcherMod = await import('../../src/jobs/dispatcher.js');
    const { bootstrapRunnerAdapters } = await import('../../src/runners/bootstrap.js');
    // Register adapters so `getRunnerAdapter('claude-code')` resolves on the
    // dispatch path. Idempotent.
    bootstrapRunnerAdapters();
    mods = { handleDispatch: dispatcherMod.handleDispatch };
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seed() {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    await createTestProjectMember(harness.db, {
      userId: owner.id,
      projectId: project.id,
      role: 'owner',
    });
    return { owner, project };
  }

  async function createJob(projectId: string, ownerId: string): Promise<string> {
    // jobs.pipeline_run_id is NOT NULL (migration 0054). Parent run is left
    // `running` so the dispatch gates treat the job as dispatchable.
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, NULL, 'system', 'running', now())
    `);
    const rows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO jobs (project_id, created_by, type, payload, status, pipeline_run_id)
      VALUES (${projectId}, ${ownerId}, 'plan', '{}'::jsonb, 'queued', ${runId})
      RETURNING id
    `);
    return (rows[0] as { id: string }).id;
  }

  // Seed a device + a `claude-code` runner bound to it. The runner is what
  // `selectRunnerForJob` resolves (status='online' + fresh last_seen_at).
  async function seedRunner(
    projectId: string,
    ownerId: string,
    opts: { status?: 'online' | 'offline' } = {},
  ): Promise<{ deviceId: string }> {
    const device = await createTestDevice(harness.db, ownerId, { status: 'online' });
    const runnerId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, host, device_id, name, capabilities, status, last_seen_at)
      VALUES (
        ${runnerId}, ${projectId}, 'claude-code', 'device', ${device.id},
        ${`runner-${runnerId.slice(0, 8)}`}, ${'{"pm": true}'}::jsonb,
        ${opts.status ?? 'online'}, now()
      )
    `);
    return { deviceId: device.id };
  }

  it('dispatches a queued job when the project has an online runner', async () => {
    const { owner, project } = await seed();
    const { deviceId } = await seedRunner(project.id, owner.id);

    const jobId = await createJob(project.id, owner.id);

    const result = await mods.handleDispatch({ jobId });
    expect(result).toBe('dispatched');

    const rows = await harness.db.execute<{ status: string; device_id: string | null }>(sql`
      SELECT status, device_id FROM jobs WHERE id = ${jobId}
    `);
    const row = rows[0] as { status: string; device_id: string | null };
    expect(row.status).toBe('dispatched');
    // The dispatcher mirrors the resolved runner's deviceId onto the job row.
    expect(row.device_id).toBe(deviceId);
  });

  it('leaves the job queued when the runner is offline', async () => {
    const { owner, project } = await seed();
    await seedRunner(project.id, owner.id, { status: 'offline' });

    const jobId = await createJob(project.id, owner.id);

    const result = await mods.handleDispatch({ jobId });
    expect(result).toBe('skipped');

    const rows = await harness.db.execute<{ status: string; device_id: string | null }>(sql`
      SELECT status, device_id FROM jobs WHERE id = ${jobId}
    `);
    const row = rows[0] as { status: string; device_id: string | null };
    expect(row.status).toBe('queued');
    expect(row.device_id).toBeNull();
  });

  it('leaves the job queued when no runner is online', async () => {
    const { owner, project } = await seed();
    const jobId = await createJob(project.id, owner.id);

    const result = await mods.handleDispatch({ jobId });
    expect(result).toBe('skipped');

    const rows = await harness.db.execute<{ status: string }>(sql`
      SELECT status FROM jobs WHERE id = ${jobId}
    `);
    expect((rows[0] as { status: string }).status).toBe('queued');
  });

  it('is a no-op on a non-queued job (idempotent against re-delivery)', async () => {
    const { owner, project } = await seed();
    await seedRunner(project.id, owner.id);

    const jobId = await createJob(project.id, owner.id);
    await harness.db.execute(sql`UPDATE jobs SET status = 'running' WHERE id = ${jobId}`);

    const result = await mods.handleDispatch({ jobId });
    expect(result).toBe('skipped');
  });

  it('is a no-op when the job row is missing', async () => {
    const result = await mods.handleDispatch({ jobId: '00000000-0000-0000-0000-000000000000' });
    expect(result).toBe('skipped');
  });
});
