import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  type TestDatabase,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// W2.1.4 integration — GET /api/issues/:id/job-history?step=<jobType> returns
// every job of the given step on the issue, newest first, with tokens/cost
// rolled up from usage_records. Access is project-member-gated identically to
// GET /api/issues/:id.

interface SeedJobOpts {
  projectId: string;
  ownerId: string;
  issueId: string;
  type: string;
  status?: string;
  modelUsed?: string | null;
  queuedAt?: Date;
  dispatchedAt?: Date | null;
  finishedAt?: Date | null;
  promptInputTokenEst?: number | null;
}

describe('GET /api/issues/:id/job-history (W2.1.4)', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

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

    const { issueRoutes } = await import('../../src/issues/routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    const jwtMod = await import('../../src/auth/jwt.js');
    signUserToken = jwtMod.signUserToken;

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/issues', issueRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seedUserProject(role: 'admin' | 'member' | 'viewer' = 'admin') {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role,
    });
    return { user, project };
  }

  // pipeline_runs has a partial unique index on (issue_id) WHERE status NOT IN
  // ('closed', 'cancelled') — only one open run per issue at a time. Seed
  // helper opens one closed run + one running run per issue and parks every
  // seeded job on the running run (matches dispatcher behaviour where all
  // jobs for an issue's lifecycle attach to the open run).
  async function seedIssueWithRun(
    projectId: string,
    createdBy: string,
  ): Promise<{ issueId: string; runId: string }> {
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, priority, created_by_id)
      VALUES (${issueId}, ${projectId}, 'iss-202 history test', 'approved', 'medium', ${createdBy})
    `);
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running')
    `);
    return { issueId, runId };
  }

  async function seedJob(opts: SeedJobOpts & { runId: string }): Promise<string> {
    const jobId = randomUUID();
    const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
    await harness.db.execute(sql`
      INSERT INTO jobs (
        id, project_id, issue_id, pipeline_run_id, created_by, type, payload, status,
        queued_at, dispatched_at, finished_at, model_used, prompt_input_token_est
      )
      VALUES (
        ${jobId}, ${opts.projectId}, ${opts.issueId}, ${opts.runId}, ${opts.ownerId},
        ${opts.type}, '{}'::jsonb, ${opts.status ?? 'succeeded'},
        ${iso(opts.queuedAt ?? new Date())},
        ${iso(opts.dispatchedAt ?? null)},
        ${iso(opts.finishedAt ?? null)},
        ${opts.modelUsed ?? null},
        ${opts.promptInputTokenEst ?? null}
      )
    `);
    return jobId;
  }

  async function seedUsage(projectId: string, jobId: string, input: number, cost: number) {
    await harness.db.execute(sql`
      INSERT INTO usage_records (
        id, project_id, source, model, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, estimated_cost,
        request_count, session_id, recorded_at
      )
      VALUES (
        ${randomUUID()}, ${projectId}, 'cli', 'claude-opus-4-7',
        ${input}, 0, 0, 0, ${cost}, 1, ${jobId}, now()
      )
    `);
  }

  async function getHistory(issueId: string, step: string, token: string) {
    return app.request(`/api/issues/${issueId}/job-history?step=${step}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it('returns plan-jobs only, newest first, with token/cost rollup', async () => {
    const { user, project } = await seedUserProject('admin');
    const { issueId, runId } = await seedIssueWithRun(project.id, user.id);

    const tOlder = new Date(Date.now() - 60_000);
    const tNewer = new Date(Date.now() - 10_000);
    const tQueued = new Date(Date.now() - 1_000);

    const olderJob = await seedJob({
      projectId: project.id,
      ownerId: user.id,
      issueId,
      runId,
      type: 'plan',
      modelUsed: 'claude-sonnet-4-6',
      queuedAt: tOlder,
      dispatchedAt: tOlder,
      finishedAt: new Date(tOlder.getTime() + 5_000),
      promptInputTokenEst: 100,
    });
    await seedUsage(project.id, olderJob, 150, 0.001);
    await seedUsage(project.id, olderJob, 50, 0.0005);

    const newerJob = await seedJob({
      projectId: project.id,
      ownerId: user.id,
      issueId,
      runId,
      type: 'plan',
      modelUsed: 'claude-opus-4-7',
      queuedAt: tNewer,
      dispatchedAt: tNewer,
      finishedAt: new Date(tNewer.getTime() + 8_000),
      promptInputTokenEst: 220,
    });
    await seedUsage(project.id, newerJob, 300, 0.005);

    // Queued (never dispatched) plan job — must still surface, tokens=0.
    const queuedJob = await seedJob({
      projectId: project.id,
      ownerId: user.id,
      issueId,
      runId,
      type: 'plan',
      status: 'queued',
      modelUsed: null,
      queuedAt: tQueued,
      dispatchedAt: null,
      finishedAt: null,
      promptInputTokenEst: 75,
    });

    // Different step on same issue — must NOT appear in ?step=plan.
    await seedJob({
      projectId: project.id,
      ownerId: user.id,
      issueId,
      runId,
      type: 'review',
      queuedAt: tNewer,
      dispatchedAt: tNewer,
      finishedAt: new Date(tNewer.getTime() + 2_000),
    });

    const token = await signUserToken(user.id);
    const res = await getHistory(issueId, 'plan', token);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{
      jobId: string;
      status: string;
      model: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      estTokens: number | null;
      tokens: number;
      cost: number;
    }>;

    expect(rows).toHaveLength(3);
    // Newest first: queued (queued_at most recent, dispatched_at null →
    // coalesce uses queued_at), then newerJob, then olderJob.
    expect(rows[0]!.jobId).toBe(queuedJob);
    expect(rows[1]!.jobId).toBe(newerJob);
    expect(rows[2]!.jobId).toBe(olderJob);

    expect(rows[0]!.tokens).toBe(0);
    expect(rows[0]!.cost).toBe(0);
    expect(rows[0]!.status).toBe('queued');
    expect(rows[0]!.startedAt).toBeNull();
    expect(rows[0]!.finishedAt).toBeNull();

    expect(rows[1]!.tokens).toBe(300);
    expect(rows[1]!.cost).toBeCloseTo(0.005, 5);
    expect(rows[1]!.model).toBe('claude-opus-4-7');

    expect(rows[2]!.tokens).toBe(200);
    expect(rows[2]!.cost).toBeCloseTo(0.0015, 5);
    expect(rows[2]!.estTokens).toBe(100);
  });

  it('returns 403 when the caller is not a project member', async () => {
    const { user: owner, project } = await seedUserProject('admin');
    const { issueId, runId } = await seedIssueWithRun(project.id, owner.id);
    await seedJob({
      projectId: project.id,
      ownerId: owner.id,
      issueId,
      runId,
      type: 'plan',
    });

    const stranger = await createTestUser(harness.db);
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${stranger.id}`,
    );

    const token = await signUserToken(stranger.id);
    const res = await getHistory(issueId, 'plan', token);
    expect(res.status).toBe(403);
  });

  it('returns 400 for an unknown step', async () => {
    const { user, project } = await seedUserProject('admin');
    const { issueId } = await seedIssueWithRun(project.id, user.id);
    const token = await signUserToken(user.id);
    const res = await app.request(`/api/issues/${issueId}/job-history?step=bogus`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown issue id', async () => {
    const { user } = await seedUserProject('admin');
    const token = await signUserToken(user.id);
    const res = await getHistory(randomUUID(), 'plan', token);
    expect(res.status).toBe(404);
  });

  it('returns [] when the issue has no jobs of the requested step', async () => {
    const { user, project } = await seedUserProject('admin');
    const { issueId, runId } = await seedIssueWithRun(project.id, user.id);
    // Seed a job of a DIFFERENT step.
    await seedJob({
      projectId: project.id,
      ownerId: user.id,
      issueId,
      runId,
      type: 'review',
    });
    const token = await signUserToken(user.id);
    const res = await getHistory(issueId, 'plan', token);
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toEqual([]);
  });
});
