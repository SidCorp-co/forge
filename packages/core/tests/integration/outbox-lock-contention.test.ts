/**
 * ISS-678 — regression coverage for the claim-then-emit shape in
 * `drainOutboxOnce`. Proves the outer connection no longer holds a row lock
 * on `pipeline_outbox` for the duration of a subscriber blocked on a
 * contended `pg_advisory_xact_lock` (the exact shape that used to pin
 * outbox-worker's transaction open), and that the claim-lease recovers a
 * row whose subscriber crashed mid-emit.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('ISS-678 outbox claim-lease under advisory-lock contention', () => {
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

  let unsubscribe: (() => void) | null = null;
  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
  });

  async function seedIssue(
    initialStatus = 'open',
  ): Promise<{ issueId: string; projectId: string }> {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, created_by_id)
      VALUES (${issueId}, ${project.id}, 'test', ${initialStatus}, ${user.id})
    `);
    return { issueId, projectId: project.id };
  }

  async function selectOutbox(issueId: string) {
    return harness.db.execute<{
      id: string;
      processed_at: Date | null;
      claimed_at: Date | null;
      attempts: number;
    }>(sql`
      SELECT id, processed_at, claimed_at, attempts
      FROM pipeline_outbox
      WHERE issue_id = ${issueId}
      ORDER BY created_at ASC
    `);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it('does not hold a pipeline_outbox row lock while a subscriber blocks on a contended advisory lock', async () => {
    const { issueId } = await seedIssue('open');
    await harness.db.execute(sql`UPDATE issues SET status = 'confirmed' WHERE id = ${issueId}`);

    const { hooks } = await import('../../src/pipeline/hooks.js');
    const { drainOutboxOnce } = await import('../../src/pipeline/outbox-worker.js');
    const { db } = await import('../../src/db/client.js');

    // cm:why simulates buildAndEnqueueStepJob's core shape: a subscriber that opens its own transaction and blocks on the SAME issue's advisory lock a concurrent process is holding
    unsubscribe = hooks.on('transition', async (payload) => {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('issue:' || ${payload.issueId}))`,
        );
      });
    });

    let releaseContendingLock: () => void = () => undefined;
    const releaseSignal = new Promise<void>((resolve) => {
      releaseContendingLock = resolve;
    });
    const contendingTx = harness.client.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('issue:' || ${issueId}))`;
      await releaseSignal;
    });

    // cm:why gives the contending connection time to actually acquire the lock before the drain (and its subscriber) races it
    await sleep(200);

    const start = Date.now();
    const drainPromise = drainOutboxOnce();

    // cm:why load-bearing: proves the claim already committed (row lock released) before hooks.emit ran — pre-ISS-678 code would raise 55P03 here since the outer db.transaction still held the row lock for the whole subscriber wait
    await sleep(100);
    await harness.client.begin(async (tx) => {
      await tx`SELECT id FROM pipeline_outbox WHERE issue_id = ${issueId} FOR UPDATE NOWAIT`;
    });

    releaseContendingLock();
    await contendingTx;
    const result = await drainPromise;
    const elapsedMs = Date.now() - start;

    expect(result.processed).toBe(1);
    // cm:why generous margin, not a tight bound — well inside the 60s statement_timeout backstop
    expect(elapsedMs).toBeLessThan(15_000);

    const rows = await selectOutbox(issueId);
    expect(rows[0]?.processed_at).not.toBeNull();
    expect(rows[0]?.claimed_at).toBeNull();
  }, 20_000);

  it('re-claims and re-emits a row whose lease expired (crash recovery)', async () => {
    const { issueId } = await seedIssue('open');
    await harness.db.execute(sql`UPDATE issues SET status = 'confirmed' WHERE id = ${issueId}`);

    // cm:why simulates a crash between claim and emit: lease set 10 minutes ago, processed_at still NULL
    await harness.db.execute(sql`
      UPDATE pipeline_outbox SET claimed_at = now() - interval '10 minutes' WHERE issue_id = ${issueId}
    `);

    const { drainOutboxOnce } = await import('../../src/pipeline/outbox-worker.js');
    const result = await drainOutboxOnce();

    expect(result.processed).toBe(1);
    const rows = await selectOutbox(issueId);
    expect(rows[0]?.processed_at).not.toBeNull();
    expect(rows[0]).toMatchObject({ claimed_at: null, attempts: 1 });
  });

  it('does not re-claim a row whose lease has not yet expired', async () => {
    const { issueId } = await seedIssue('open');
    await harness.db.execute(sql`UPDATE issues SET status = 'confirmed' WHERE id = ${issueId}`);
    await harness.db.execute(sql`
      UPDATE pipeline_outbox SET claimed_at = now() WHERE issue_id = ${issueId}
    `);

    const { drainOutboxOnce } = await import('../../src/pipeline/outbox-worker.js');
    const result = await drainOutboxOnce();

    expect(result.processed).toBe(0);
    const rows = await selectOutbox(issueId);
    expect(rows[0]).toMatchObject({ processed_at: null, attempts: 0 });
  });
});
