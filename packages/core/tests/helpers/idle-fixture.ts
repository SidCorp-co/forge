/**
 * ISS-1122 — the database setup the idle-issue suites share.
 *
 * Both suites seed the same shapes: an issue at a status with a lease, a run, a job, a runner in
 * or out of the job pool. Carrying two copies of that is how one suite's fixture drifts from the
 * other's and the two stop proving the same thing about the same rows.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { setupTestDatabase, type TestDatabase } from './db.js';
import { createTestDevice, createTestProject, createTestUser } from './factories.js';
import { truncateAll } from './truncate.js';

/** Older than every watched grace in the rule table, so no case turns on the clock by accident. */
export const LONG_AGO = '2026-09-13T00:00:00.000Z';

export interface IdleFixture {
  readonly db: TestDatabase['db'];
  readonly projectId: string;
  readonly ownerId: string;
  /** The `iss_seq` the last seeded issue was given. */
  readonly lastSeq: number;
  seedIssue(args: {
    status: string;
    sessionContext?: unknown;
    mergedAt?: string | null;
    updatedAt?: string;
  }): Promise<string>;
  seedRun(issueId: string | null, status: string): Promise<string>;
  /** A job under a live run: the INV-1 trigger cancels one inserted under a terminal run. */
  seedLiveJob(issueId: string): Promise<string>;
  seedRunner(status: 'online' | 'draining' | 'disabled'): Promise<void>;
  /** A fleet-wide lease on `ISS-<seq>` held by a session in `sessionStatus` (ISS-1109). */
  seedIssueLease(issSeq: number, sessionStatus: string): Promise<void>;
}

/**
 * Register the suite's hooks and hand back a fixture whose fields follow each `beforeEach`.
 */
export function registerIdleFixture(seqFrom: number): IdleFixture {
  let harness: TestDatabase;
  let projectId = '';
  let ownerId = '';
  let seq = seqFrom;

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

  return {
    get db() {
      return harness.db;
    },
    get projectId() {
      return projectId;
    },
    get ownerId() {
      return ownerId;
    },
    get lastSeq() {
      return seq - 1;
    },
    async seedIssue(args) {
      const id = randomUUID();
      const ctx = args.sessionContext === undefined ? null : JSON.stringify(args.sessionContext);
      await harness.db.execute(sql`
        INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id,
                            session_context, merged_at, created_at, updated_at)
        VALUES (${id}, ${projectId}, ${seq++}, 'idle row', ${args.status}, 'medium', ${ownerId},
                ${ctx}::jsonb, ${args.mergedAt ?? null}::timestamptz,
                ${LONG_AGO}::timestamptz, ${args.updatedAt ?? LONG_AGO}::timestamptz)
      `);
      return id;
    },
    async seedRun(issueId, status) {
      const runId = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
        VALUES (${runId}, ${projectId}, ${issueId}, ${issueId ? 'issue' : 'system'}, ${status}, now())
      `);
      return runId;
    },
    async seedLiveJob(issueId) {
      const runId = await this.seedRun(issueId, 'running');
      await harness.db.execute(sql`
        INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, created_by)
        VALUES (${randomUUID()}, ${projectId}, ${issueId}, ${runId}, 'drive', 'running', ${ownerId})
      `);
      return runId;
    },
    async seedRunner(status) {
      const device = await createTestDevice(harness.db, ownerId);
      await harness.db.execute(sql`
        INSERT INTO runners (id, project_id, device_id, type, name, status)
        VALUES (${randomUUID()}, ${projectId}, ${device.id}, 'claude-code', ${`runner-${status}`}, ${status})
      `);
    },
    async seedIssueLease(issSeq, sessionStatus) {
      const device = await createTestDevice(harness.db, ownerId);
      const runId = randomUUID();
      const sessionId = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
        VALUES (${runId}, ${projectId}, 'system', 'running', now())
      `);
      await harness.db.execute(sql`
        INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status)
        VALUES (${sessionId}, ${projectId}, ${device.id}, ${runId}, 'run_session', ${sessionStatus})
      `);
      await harness.db.execute(sql`
        INSERT INTO issue_leases (project_id, issue_key, device_id, session_id, run_id)
        VALUES (${projectId}, ${`ISS-${issSeq}`}, ${device.id}, ${sessionId}, ${runId})
      `);
    },
  };
}

/** The lease shape the CLI writes, with whatever a case needs changed. */
export function testLease(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    holder: '3f3ce366-efde-4a30-b427-8fe1f9e99809',
    pid: '834556',
    tree: '/home/dev/forge/worktrees/forge-dev/iss-1105',
    minutes: 60,
    renewedAt: '2026-09-20T15:45:00.000Z',
    history: [{ at: '2026-09-20T15:45:00.000Z', how: 'claim' }],
    ...over,
  };
}
