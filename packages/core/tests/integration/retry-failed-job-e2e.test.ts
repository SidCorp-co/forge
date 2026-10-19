/**
 * ISS-1229 r16 — judge-41: the project page's "Approve & retry" opened the issue and retried nothing,
 * and no route let a person retry a job that failed for good. `POST /api/jobs/:id/retry` queues it
 * again as a new job naming the one it retries, for a member of the job's project, audited on the
 * failed row; the failure then leaves the reader's Needs you list because something retried it.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

vi.mock('../../src/ws/server.js', () => ({ roomManager: { publish: () => undefined } }));
vi.mock('../../src/issues/pipeline-health.js', () => ({
  publishPipelineHealthChanged: async () => undefined,
}));

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let ownerId = '';
let projectId = '';
let issueId = '';
let runId = '';
const tokens = new Map<string, string>();

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const { jobLifecycleUserRoutes } = await import('../../src/jobs/lifecycle-routes.js');
  const { meAttentionRoutes } = await import('../../src/me/attention-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/jobs', jobLifecycleUserRoutes);
  app.route('/api/me', meAttentionRoutes);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

async function signIn(userId: string): Promise<void> {
  const { signUserToken } = await import('../../src/auth/jwt.js');
  tokens.set(userId, await signUserToken(userId));
}

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  projectId = (await createTestProject(harness.db, ownerId, { name: 'Ledger' })).id;
  issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, created_by_id, iss_seq)
    VALUES (${issueId}, ${projectId}, 'Export the ledger', 'in_progress', ${ownerId}, 7)
  `);
  runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
    VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running', now())
  `);
  await signIn(ownerId);
});

async function seedJob(status: string, on: string | null = issueId): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status, payload,
                      attempts, error, failure_reason, finished_at)
    VALUES (${id}, ${projectId}, ${on}, ${runId}, ${ownerId}, 'drive', ${status},
            ${JSON.stringify({ _autoRetry: { round: 10 }, keep: 'me' })}::jsonb, 4,
            'the agent exited with code 1', 'non_retryable_terminal', now() - interval '1 hour')
  `);
  return id;
}

const retry = (jobId: string, as = ownerId) =>
  app.request(`/api/jobs/${jobId}/retry`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.get(as)}` },
  });

async function failedJobIds(): Promise<string[]> {
  const res = await app.request('/api/me/attention', {
    headers: { authorization: `Bearer ${tokens.get(ownerId)}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { failedJobs: Array<{ jobId?: string }> };
  return body.failedJobs.map((f) => f.jobId ?? '(none)');
}

describe('a person retries a failed job', () => {
  it('queues it again as a new job naming the one it retries, and it leaves Needs you', async () => {
    const failed = await seedJob('failed');
    expect(await failedJobIds()).toEqual([failed]);

    const res = await retry(failed);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobId: string; retryOf: string; status: string };
    expect(body.retryOf).toBe(failed);
    expect(body.status).toBe('queued');

    const [row] = await harness.db.execute<{
      status: string;
      retry_of: string;
      attempts: number;
      payload: Record<string, unknown>;
      issue_id: string;
    }>(
      sql`SELECT status, retry_of, attempts, payload, issue_id FROM jobs WHERE id = ${body.jobId}`,
    );
    expect(row).toMatchObject({
      status: 'queued',
      retry_of: failed,
      attempts: 5,
      issue_id: issueId,
    });
    expect(row?.payload).toEqual({ keep: 'me' });

    const [audit] = await harness.db.execute<{ data: Record<string, unknown> }>(
      sql`SELECT data FROM job_events WHERE job_id = ${failed} AND kind = 'intervention'`,
    );
    expect(audit?.data).toMatchObject({
      action: 'retry',
      actor: ownerId,
      previousStatus: 'failed',
    });

    expect(await failedJobIds()).toEqual([]);
  });

  it('refuses a second retry of the same failure, naming the retry that stands', async () => {
    const failed = await seedJob('failed');
    expect((await retry(failed)).status).toBe(200);

    const again = await retry(failed);
    expect(again.status).toBe(409);
    expect(JSON.stringify(await again.json())).toContain('ALREADY_RETRIED');
  });

  it('refuses a job that has not failed, by name', async () => {
    const running = await seedJob('running');
    const res = await retry(running);
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('NOT_FAILED');
  });

  it('lists no failure of a dropped issue, which nobody retries', async () => {
    await seedJob('failed');
    await harness.db.execute(sql`UPDATE issues SET status = 'dropped' WHERE id = ${issueId}`);
    expect(await failedJobIds()).toEqual([]);
  });

  it('refuses a failure on a finished issue', async () => {
    const failed = await seedJob('failed');
    await harness.db.execute(sql`UPDATE issues SET status = 'dropped' WHERE id = ${issueId}`);
    const res = await retry(failed);
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('ISSUE_RESOLVED');
  });

  it('refuses a failure on an archived issue', async () => {
    const failed = await seedJob('failed');
    await harness.db.execute(sql`UPDATE issues SET archived_at = now() WHERE id = ${issueId}`);
    const res = await retry(failed);
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('ISSUE_ARCHIVED');
  });

  it('opens a run for the issue where the failed job’s run has closed', async () => {
    const failed = await seedJob('failed');
    await harness.db.execute(
      sql`UPDATE pipeline_runs SET status = 'failed', finished_at = now() WHERE id = ${runId}`,
    );
    const res = await retry(failed);
    expect(res.status).toBe(200);
    const { jobId } = (await res.json()) as { jobId: string };
    const [row] = await harness.db.execute<{ pipeline_run_id: string }>(
      sql`SELECT pipeline_run_id FROM jobs WHERE id = ${jobId}`,
    );
    expect(row?.pipeline_run_id).not.toBe(runId);
  });

  it('refuses a caller who is not a member of the job’s project', async () => {
    const failed = await seedJob('failed');
    const stranger = (await createTestUser(harness.db)).id;
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${stranger}`,
    );
    await signIn(stranger);
    const res = await retry(failed, stranger);
    expect(res.status).toBe(403);
    const [n] = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM jobs WHERE retry_of = ${failed}`,
    );
    expect(Number(n?.n)).toBe(0);
  });
});
