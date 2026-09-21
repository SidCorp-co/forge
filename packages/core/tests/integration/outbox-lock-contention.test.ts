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
    const { closeDb } = await import('../../src/db/client.js');
    await closeDb();
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

  async function waitForClaimCommitted(issueId: string, deadlineMs = 10_000): Promise<void> {
    const started = Date.now();
    do {
      const rows = await harness.db.execute<{ claimed: boolean }>(
        sql`SELECT claimed_at IS NOT NULL AS claimed FROM pipeline_outbox WHERE issue_id = ${issueId}`,
      );
      if (rows.some((r) => (r as { claimed: boolean }).claimed)) return;
      await sleep(25);
    } while (Date.now() - started < deadlineMs);
  }

  it('does not hold a pipeline_outbox row lock while a subscriber blocks on a contended advisory lock', async () => {
    const { issueId } = await seedIssue('open');
    await harness.db.execute(sql`UPDATE issues SET status = 'confirmed' WHERE id = ${issueId}`);

    const { hooks } = await import('../../src/pipeline/hooks.js');
    const { drainOutboxOnce } = await import('../../src/pipeline/outbox-worker.js');
    const { db } = await import('../../src/db/client.js');

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

    await sleep(200);

    const start = Date.now();
    const drainPromise = drainOutboxOnce();

    await waitForClaimCommitted(issueId);
    try {
      await harness.client.begin(async (tx) => {
        await tx`SELECT id FROM pipeline_outbox WHERE issue_id = ${issueId} FOR UPDATE NOWAIT`;
      });
    } finally {
      releaseContendingLock();
    }

    await contendingTx;
    const result = await drainPromise;
    const elapsedMs = Date.now() - start;

    expect(result.processed).toBe(1);
    expect(elapsedMs).toBeLessThan(15_000);

    const rows = await selectOutbox(issueId);
    expect(rows[0]?.processed_at).not.toBeNull();
    expect(rows[0]?.claimed_at).toBeNull();
  }, 20_000);

  it('the wait+probe pair still reports 55P03 when a claim is stamped but never committed (pre-ISS-678 shape)', async () => {
    const { issueId } = await seedIssue('open');
    await harness.db.execute(sql`UPDATE issues SET status = 'confirmed' WHERE id = ${issueId}`);

    let releaseHeldClaim: () => void = () => undefined;
    const heldSignal = new Promise<void>((resolve) => {
      releaseHeldClaim = resolve;
    });
    const uncommittedClaim = harness.client.begin(async (tx) => {
      await tx`UPDATE pipeline_outbox SET claimed_at = now() WHERE issue_id = ${issueId}`;
      await heldSignal;
    });

    try {
      await waitForClaimCommitted(issueId, 300);
      await expect(
        harness.client.begin(async (tx) => {
          await tx`SELECT id FROM pipeline_outbox WHERE issue_id = ${issueId} FOR UPDATE NOWAIT`;
        }),
      ).rejects.toThrow(/could not obtain lock/);
    } finally {
      releaseHeldClaim();
      await uncommittedClaim;
    }
  });

  it('re-claims and re-emits a row whose lease expired (crash recovery)', async () => {
    const { issueId } = await seedIssue('open');
    await harness.db.execute(sql`UPDATE issues SET status = 'confirmed' WHERE id = ${issueId}`);

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
