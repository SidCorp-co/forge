import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// ISS-267 regression — `GET /api/projects/health` 500'd on staging because the
// throughput query passed a JS Date through Drizzle's `sql` template, and
// postgres-js cannot serialize Date instances at Bind time
// (`ERR_INVALID_ARG_TYPE` from Buffer.byteLength). Mock-based tests didn't
// catch it because they never hit the real driver. These tests run against a
// real Postgres so any future Date-binding regression in this handler will
// surface here.

describe('ISS-267 /api/projects/health integration', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>;
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

    const { projectHealthRoutes } = await import('../../src/projects/health-routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    const jwtMod = await import('../../src/auth/jwt.js');
    signUserToken = jwtMod.signUserToken;

    app = new Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/projects', projectHealthRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seedOwner() {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'owner',
    });
    const token = await signUserToken(user.id);
    return { user, project, token };
  }

  async function insertIssue(args: {
    projectId: string;
    createdById: string;
    status?: string;
    issSeq?: number;
  }) {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${args.projectId}, ${args.issSeq ?? 1}, ${'t'}, ${args.status ?? 'open'}, ${args.createdById})
    `);
    return id;
  }

  async function insertActivity(args: {
    issueId: string;
    actorId: string;
    action: string;
    payload: object;
    createdAt?: string;
  }) {
    const id = randomUUID();
    const created = args.createdAt
      ? sql`${args.createdAt}::timestamptz`
      : sql`now()`;
    await harness.db.execute(sql`
      INSERT INTO activity_log (id, issue_id, actor_type, actor_id, action, payload, created_at)
      VALUES (${id}, ${args.issueId}, ${'user'}, ${args.actorId}, ${args.action}, ${JSON.stringify(args.payload)}::jsonb, ${created})
    `);
  }

  it('returns 200 with throughput=0 when there is no activity (regression: no Date binding crash)', async () => {
    const { project, token } = await seedOwner();

    const res = await app.request('/api/projects/health', {
      headers: { authorization: `Bearer ${token}` },
    });

    // The pre-fix bug threw before any row work — even an empty project
    // returned 500. Asserting 200 here locks in the binding fix.
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ projectSlug: string; throughput: number }>;
    const row = body.find((r) => r.projectSlug === project.slug);
    expect(row).toBeDefined();
    expect(row?.throughput).toBe(0);
  });

  it('counts issue.statusChanged → closed/released within last 7 days', async () => {
    const { user, project, token } = await seedOwner();

    const issueA = await insertIssue({
      projectId: project.id,
      createdById: user.id,
      issSeq: 1,
    });
    const issueB = await insertIssue({
      projectId: project.id,
      createdById: user.id,
      issSeq: 2,
    });

    await insertActivity({
      issueId: issueA,
      actorId: user.id,
      action: 'issue.statusChanged',
      payload: { from: 'in_progress', to: 'closed' },
    });
    await insertActivity({
      issueId: issueB,
      actorId: user.id,
      action: 'issue.statusChanged',
      payload: { from: 'staging', to: 'released' },
    });

    const res = await app.request('/api/projects/health', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ projectSlug: string; throughput: number }>;
    const row = body.find((r) => r.projectSlug === project.slug);
    expect(row?.throughput).toBe(2);
  });

  it('excludes transitions to non-closed/released states', async () => {
    const { user, project, token } = await seedOwner();
    const issueId = await insertIssue({
      projectId: project.id,
      createdById: user.id,
    });
    await insertActivity({
      issueId,
      actorId: user.id,
      action: 'issue.statusChanged',
      payload: { from: 'open', to: 'in_progress' },
    });

    const res = await app.request('/api/projects/health', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ projectSlug: string; throughput: number }>;
    const row = body.find((r) => r.projectSlug === project.slug);
    expect(row?.throughput).toBe(0);
  });

  it('excludes activity older than 7 days', async () => {
    const { user, project, token } = await seedOwner();
    const issueId = await insertIssue({
      projectId: project.id,
      createdById: user.id,
    });
    // 8 days ago — outside the rolling window.
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await insertActivity({
      issueId,
      actorId: user.id,
      action: 'issue.statusChanged',
      payload: { from: 'staging', to: 'released' },
      createdAt: eightDaysAgo,
    });

    const res = await app.request('/api/projects/health', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ projectSlug: string; throughput: number }>;
    const row = body.find((r) => r.projectSlug === project.slug);
    expect(row?.throughput).toBe(0);
  });
});
