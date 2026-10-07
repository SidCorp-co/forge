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
    expect(said).toContain('Decisions panel');
    expect(said).toContain(`shipped as version ${version}`);
    expect(said).toContain('move it to Closed from its status menu');
    expect(said).not.toMatch(/\/api\/|voidQuestions/);
  });

  it('closes the refused issue the way its comment says: withdrawing its questions while moving it to Closed', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const { transitionIssueStatus } = await import('../../src/issues/apply-transition.js');
    const held = await fx.insertIssue();
    const { runId } = await fx.claim([held]);
    const question = await askOn(held);
    await finishReleaseBatch(runId, { type: 'user', id: ownerId });
    expect((await fx.stored(held)).status).toBe('awaiting_release');

    await transitionIssueStatus(
      { id: held, projectId, status: 'awaiting_release', reopenCount: 0 },
      'closed',
      { type: 'user', id: ownerId },
      { voidQuestions: 'the release shipped it; the question no longer decides anything' },
    );

    expect((await fx.stored(held)).status).toBe('closed');
    const [q] = await harness.db.execute(
      sql`SELECT status FROM agent_questions WHERE id = ${question}`,
    );
    expect(q?.status).not.toBe('open');
  });

  it('names the database’s reason for a close that failed, and never the statement or a bound value', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const broken = await fx.insertIssue();
    const free = await fx.insertIssue();
    const { runId } = await fx.claim([broken, free]);
    await harness.db.execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION planted_close_failure() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'closed' AND NEW.id = '${broken}' THEN
          RAISE EXCEPTION 'planted failure: storage refused this row';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER planted_close_failure BEFORE UPDATE ON issues
        FOR EACH ROW EXECUTE FUNCTION planted_close_failure();
    `),
    );
    try {
      const result = await finishReleaseBatch(runId, { type: 'user', id: ownerId });

      expect(result.closed).toEqual([free]);
      const said = await lastComment(broken);
      const reason = result.failed.find((f) => f.id === broken)?.reason ?? '';
      for (const text of [said, reason]) {
        expect(text).toContain('planted failure: storage refused this row');
        expect(text).toContain('P0001');
        for (const leaked of ['Failed query', 'update "issues"', 'params:', broken]) {
          expect(text).not.toContain(leaked);
        }
      }
    } finally {
      await harness.db.execute(sql.raw('DROP TRIGGER IF EXISTS planted_close_failure ON issues'));
    }
  });

  it('names the refusal on a batch that recorded a promotion, where the issue stays claimed', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const { openAttempt } = await import('../../src/release-batch/ledger.js');
    const held = await fx.insertIssue();
    const free = await fx.insertIssue();
    const { runId, version } = await fx.claim([held, free]);
    await openAttempt({
      runId,
      stage: 'promote',
      idempotencyKey: 'promote-1',
      commit: 'a'.repeat(40),
    });
    const question = await askOn(held);

    const result = await finishReleaseBatch(runId, { type: 'user', id: ownerId });

    expect(result.closed).toEqual([free]);
    expect((await fx.stored(held)).status).toBe('releasing');
    const said = await lastComment(held);
    expect(said).toContain('`OPEN_QUESTIONS`');
    expect(said).toContain(`open question ${question}`);
    expect(said).toContain('What clears it: answer each open question in the Decisions panel');
    expect(said).toContain(`shipped as version ${version}`);
    expect(said).toContain('stay at `releasing`');
    expect(said).toContain(`/release-batches/${runId}/abort`);
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
