/**
 * ISS-1381 — a finish that cannot close an issue says why on that issue. Measured on sid-desk, a
 * batch of 18 closed 15 and left two at `awaiting_release` with a comment naming no reason, while
 * the refusal behind it was `OPEN_QUESTIONS`, found only by sending the move again by hand.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

describe('a release finish that cannot close an issue', () => {
  let harness: TestDatabase;
  let projectId: string;
  let ownerId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.NODE_ENV ??= 'test';
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    await registerIntegrationsForTest();
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    projectId = (await createTestProject(harness.db, owner.id)).id;
    await fx.declareProduction();
    await fx.seedReleaseRunner();
  });

  const fx = releaseBatchFixture(
    () => harness,
    () => ({ projectId, ownerId }),
  );

  async function askOn(issueId: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps)
      VALUES (${id}, ${projectId}, ${issueId}, 'open', 'human', '[{"round":1}]'::jsonb)
    `);
    return id;
  }

  async function lastComment(issueId: string): Promise<string> {
    const rows = await harness.db.execute(sql`
      SELECT body FROM comments WHERE issue_id = ${issueId} ORDER BY created_at DESC LIMIT 1
    `);
    return String(rows[0]?.body ?? '');
  }

  it('names the refusal, each open question and what clears it, and the other issues close', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const held = await fx.insertIssue();
    const free = await fx.insertIssue();
    const { runId, version } = await fx.claim([held, free]);
    const first = await askOn(held);
    const second = await askOn(held);

    const result = await finishReleaseBatch(runId, { type: 'user', id: ownerId });

    expect(result.closed).toEqual([free]);
    expect((await fx.stored(free)).status).toBe('closed');
    expect((await fx.stored(held)).status).toBe('awaiting_release');
    const said = await lastComment(held);
    expect(said).toContain('`OPEN_QUESTIONS`');
    expect(said).toContain(`open question ${first}`);
    expect(said).toContain(`open question ${second}`);
    expect(said).toContain('What clears it: this issue holds 2 open questions');
    expect(said).toContain(`shipped as version ${version}`);
    expect(said).toContain(`POST /api/projects/${projectId}/release-records`);
  });

  it('writes the comment as the device owner when a device finished the batch', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const held = await fx.insertIssue();
    const { runId } = await fx.claim([held]);
    const question = await askOn(held);

    await finishReleaseBatch(runId, { type: 'device', id: randomUUID(), ownerId });

    const said = await lastComment(held);
    expect(said).toContain('`OPEN_QUESTIONS`');
    expect(said).toContain(`open question ${question}`);
  });
});
