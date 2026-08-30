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
 * `reapOrphanedIssueRuns` covers every member of `RUN_CLOSING_STATUSES`.
 *
 * The pass is the only backstop for `apply-transition.ts`'s close block, and it
 * filtered `i.status = 'closed'` while that set has been `{closed, dropped}` —
 * so a `dropped` issue whose close bypassed `applyTransition` left its run
 * `running` forever, and any `queued` child under it orphaned with it. On an
 * autonomous project that is not a corner case: `dropped` is one of the five
 * statuses the driver may write.
 *
 * A mocked `db.execute` returns whatever the test feeds it, so it cannot prove
 * which statuses the WHERE admits. Only real SQL can.
 */
describe('reapOrphanedIssueRuns status coverage E2E (ISS-879)', () => {
  let harness: TestDatabase;
  let mods: { reapOrphanedIssueRuns: (now?: Date) => Promise<{ reaped: number }> };
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

    mods = (await import('../../src/pipeline/sweeper.js')) as unknown as typeof mods;
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

  let s = 900;
  async function runUnderIssueAt(status: string): Promise<string> {
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (${issueId}, ${projectId}, ${s++}, 'terminal issue', ${status}, 'medium', ${ownerId})
    `);
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running', now() - interval '30 days')
    `);
    return runId;
  }

  async function runStatus(runId: string): Promise<string> {
    const rows = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM pipeline_runs WHERE id = ${runId}`,
    );
    return rows[0]?.status ?? 'missing';
  }

  it.each(['closed', 'dropped'])('closes a leaked run under a `%s` issue', async (status) => {
    const runId = await runUnderIssueAt(status);

    const res = await mods.reapOrphanedIssueRuns(new Date());

    expect(res.reaped).toBe(1);
    expect(await runStatus(runId)).toBe('completed');
  });

  // cm:guard `released` must stay OUT of the list — the release step runs inside the still-open run (ISS-669), so reaping there cancels the job doing the release
  it.each(['released', 'waiting', 'in_progress'])(
    'leaves a run under a non-run-closing `%s` issue alone',
    async (status) => {
      const runId = await runUnderIssueAt(status);

      const res = await mods.reapOrphanedIssueRuns(new Date());

      expect(res.reaped).toBe(0);
      expect(await runStatus(runId)).toBe('running');
    },
  );
});
