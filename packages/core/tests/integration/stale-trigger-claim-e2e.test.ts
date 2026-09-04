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

describe('stale-trigger claim E2E', () => {
  let harness: TestDatabase;
  let claimRunnerSlot: typeof import('../../src/jobs/dispatch-gates.js').claimRunnerSlot;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';
    ({ claimRunnerSlot } = await import('../../src/jobs/dispatch-gates.js'));
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  it('does not claim a queued job after its declared trigger moved on', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const device = await createTestDevice(harness.db, owner.id, { status: 'online' });
    const runnerId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const jobId = randomUUID();

    await harness.db.execute(sql`UPDATE devices SET last_seen_at = now() WHERE id = ${device.id}`);
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, capabilities, status, last_seen_at)
      VALUES (${runnerId}, ${project.id}, 'claude-code', ${device.id}, 'runner', '{}'::jsonb, 'online', now())
    `);
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (${issueId}, ${project.id}, 1, 'stale', 'testing', 'medium', ${owner.id})
    `);
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${project.id}, ${issueId}, 'issue', 'running', now())
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, type, status, pipeline_run_id, payload, queued_at, created_by)
      VALUES (${jobId}, ${project.id}, ${issueId}, 'code', 'queued', ${runId}, '{"stageStatus":"approved"}'::jsonb, now(), ${owner.id})
    `);

    const result = await claimRunnerSlot({
      jobId,
      runnerId,
      deviceId: device.id,
      dispatchedAt: new Date(),
    });
    const rows = await harness.db.execute<{ status: string; runner_id: string | null }>(sql`
      SELECT status, runner_id FROM jobs WHERE id = ${jobId}
    `);

    expect(result).toBe('lost');
    expect(rows[0]).toEqual({ status: 'queued', runner_id: null });
  });
});
