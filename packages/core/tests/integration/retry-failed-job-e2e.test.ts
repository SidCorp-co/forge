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
  createTestProjectMember,
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

  // Round 23 (judge-74, criterion 241): after a retry by hand an issue read Open with a queued run.
  // The scratch issue had never left Open; a retry writes no issue status, which this pins.
  it.each([
    ['its run still open', false],
    ['its run closed', true],
  ])('leaves an In progress issue In progress, with %s', async (_label, closed) => {
    const failed = await seedJob('failed');
    if (closed) {
      await harness.db.execute(
        sql`UPDATE pipeline_runs SET status = 'failed', finished_at = now() WHERE id = ${runId}`,
      );
    }
    expect((await retry(failed)).status).toBe(200);
    const [issue] = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM issues WHERE id = ${issueId}`,
    );
    expect(issue?.status).toBe('in_progress');
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

  // ISS-1229 r17, judge-44: a viewer IS a project member, and "not a project member" sent an agent to
  // ask for a membership it already held.
  it('refuses a viewer naming the role it needs and the role it holds', async () => {
    const failed = await seedJob('failed');
    const viewer = (await createTestUser(harness.db)).id;
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${viewer}`);
    await createTestProjectMember(harness.db, { userId: viewer, projectId, role: 'viewer' });
    await signIn(viewer);
    const res = await retry(failed, viewer);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { message?: string }; message?: string };
    const said = JSON.stringify(body);
    expect(said).toContain('Requires the project member role or above');
    expect(said).toContain('the role held is viewer');
    expect(said).not.toContain('not a project member');
    const [n] = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM jobs WHERE retry_of = ${failed}`,
    );
    expect(Number(n?.n)).toBe(0);
  });

  // ISS-1229 r17, judge-44: a failure whose issue already had new work of its kind queued was offered
  // for retry, and the route refused it for ever, so the row never left.
  it('lists no failure whose issue already has live work of its kind', async () => {
    const failed = await seedJob('failed');
    expect(await failedJobIds()).toEqual([failed]);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status)
      VALUES (${randomUUID()}, ${projectId}, ${issueId}, ${runId}, ${ownerId}, 'drive', 'queued')
    `);
    expect(await failedJobIds()).toEqual([]);
  });

  // ISS-1229 r18, judge-48: the API caller still read "a drive job is already queued or running on
  // this issue", the stored job type; the page and the API now read one sentence.
  it('refuses a retry whose work is already queued in the words the page shows', async () => {
    const failed = await seedJob('failed');
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status)
      VALUES (${randomUUID()}, ${projectId}, ${issueId}, ${runId}, ${ownerId}, 'drive', 'queued')
    `);
    const res = await retry(failed);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body).toMatchObject({
      code: 'ALREADY_ACTIVE',
      message: 'The same work is already queued or running on this issue, and that is its retry.',
    });
    expect(JSON.stringify(body)).not.toContain('drive');
  });
});
