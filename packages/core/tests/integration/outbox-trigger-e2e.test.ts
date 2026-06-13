/**
 * ISS-196 — integration tests for the `pipeline_outbox` AFTER UPDATE trigger
 * on issues.status. Validates:
 *
 *   1. Trigger fires exactly once per status change and skips no-op updates.
 *   2. `set_config('pipeline.actor_*', ..., true)` inside the same tx stamps
 *      the outbox row's actor metadata.
 *   3. Raw SQL UPDATE that skips `set_config` falls through with
 *      actor_id=NULL and actor_type='system' — matches the acceptance
 *      criterion "raw SQL UPDATE still triggers the pipeline."
 *   4. `drainOutboxOnce` walks the unprocessed batch and stamps processed_at.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('ISS-196 pipeline_outbox trigger', () => {
  let harness: TestDatabase;

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
  });

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seedIssue(initialStatus = 'open'): Promise<{
    issueId: string;
    projectId: string;
    userId: string;
  }> {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, created_by_id)
      VALUES (${issueId}, ${project.id}, 'test', ${initialStatus}, ${user.id})
    `);
    return { issueId, projectId: project.id, userId: user.id };
  }

  async function selectOutbox(issueId: string) {
    return harness.db.execute<{
      id: string;
      issue_id: string;
      project_id: string;
      from_status: string;
      to_status: string;
      actor_id: string | null;
      actor_type: string | null;
      reason: string | null;
      processed_at: Date | null;
      attempts: number;
    }>(sql`
      SELECT id, issue_id, project_id, from_status, to_status,
             actor_id, actor_type, reason, processed_at, attempts
      FROM pipeline_outbox
      WHERE issue_id = ${issueId}
      ORDER BY created_at ASC
    `);
  }

  it('writes exactly one outbox row per status change', async () => {
    const { issueId, projectId } = await seedIssue('open');

    await harness.db.execute(sql`
      UPDATE issues SET status = 'confirmed' WHERE id = ${issueId}
    `);

    const rows = await selectOutbox(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      issue_id: issueId,
      project_id: projectId,
      from_status: 'open',
      to_status: 'confirmed',
      processed_at: null,
      attempts: 0,
    });
  });

  it('does NOT write an outbox row when status is unchanged', async () => {
    const { issueId } = await seedIssue('open');

    // UPDATE that touches status with the same value should not fire (trigger
    // guards on `OLD.status IS DISTINCT FROM NEW.status`).
    await harness.db.execute(sql`
      UPDATE issues SET status = 'open', title = 'renamed' WHERE id = ${issueId}
    `);

    const rows = await selectOutbox(issueId);
    expect(rows).toHaveLength(0);
  });

  it('writes actor_id=NULL, actor_type=system when no set_config has been called', async () => {
    const { issueId } = await seedIssue('open');

    // Raw UPDATE on its own — no set_config, no app code. Matches
    // acceptance criteria: psql / external scripts must still fire.
    await harness.db.execute(sql`
      UPDATE issues SET status = 'confirmed' WHERE id = ${issueId}
    `);

    const rows = await selectOutbox(issueId);
    expect(rows[0]).toMatchObject({ actor_id: null, actor_type: 'system' });
  });

  it('reads actor_id/actor_type/reason from SET LOCAL pipeline.* settings', async () => {
    const { issueId } = await seedIssue('open');

    await harness.db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT
          set_config('pipeline.actor_id', 'u-99', true),
          set_config('pipeline.actor_type', 'user', true),
          set_config('pipeline.reason', 'manual override', true)
      `);
      await tx.execute(sql`
        UPDATE issues SET status = 'confirmed' WHERE id = ${issueId}
      `);
    });

    const rows = await selectOutbox(issueId);
    expect(rows[0]).toMatchObject({
      actor_id: 'u-99',
      actor_type: 'user',
      reason: 'manual override',
    });
  });

  it('drainOutboxOnce stamps processed_at on dispatched rows', async () => {
    const { issueId } = await seedIssue('open');
    await harness.db.execute(sql`
      UPDATE issues SET status = 'confirmed' WHERE id = ${issueId}
    `);

    // Import lazily — the worker module reads from `db/client.js` which
    // pulls the env-bound singleton.
    const { drainOutboxOnce } = await import('../../src/pipeline/outbox-worker.js');

    const result = await drainOutboxOnce();
    expect(result.processed).toBe(1);

    const rows = await selectOutbox(issueId);
    expect(rows[0]?.processed_at).not.toBeNull();
  });
});
