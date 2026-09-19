import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

/**
 * ISS-1018 — the cycle figure, after the correlated `min()` became one CTE pass.
 *
 * `avgCycleTimeDays` averages, over every qualifying completion event in the
 * last seven days, the days from that issue's FIRST transition into
 * `in_progress`/`approved` to the completion. Each case here is a different
 * branch of the same SQL, and every one of them passes against the correlated
 * subquery this replaced — equivalence is what is asserted, not a new figure.
 *
 * It lives beside `health-routes.test.ts` rather than inside it because that
 * file's suite is at its frozen size budget.
 */
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
    role: 'admin',
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
  const created = args.createdAt ? sql`${args.createdAt}::timestamptz` : sql`now()`;
  await harness.db.execute(sql`
    INSERT INTO activity_log (id, issue_id, actor_type, actor_id, action, payload, created_at)
    VALUES (${id}, ${args.issueId}, ${'user'}, ${args.actorId}, ${args.action}, ${JSON.stringify(args.payload)}::jsonb, ${created})
  `);
}

async function cycleDays(token: string, slug: string): Promise<number | undefined> {
  const res = await app.request('/api/projects/health', {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Array<{ projectSlug: string; avgCycleTimeDays: number }>;
  return body.find((r) => r.projectSlug === slug)?.avgCycleTimeDays;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe('the cycle figure, branch by branch', () => {
  it('measures from a work-start that predates the seven-day completion window', async () => {
    const { user, project, token } = await seedOwner();
    const issueId = await insertIssue({ projectId: project.id, createdById: user.id });

    await insertActivity({
      issueId,
      actorId: user.id,
      action: 'issue.statusChanged',
      payload: { from: 'approved', to: 'in_progress' },
      createdAt: daysAgo(30),
    });
    await insertActivity({
      issueId,
      actorId: user.id,
      action: 'issue.statusChanged',
      payload: { from: 'in_progress', to: 'closed' },
      createdAt: daysAgo(2),
    });

    expect(await cycleDays(token, project.slug)).toBeCloseTo(28, 1);
  });

  it('falls back to the issue creation time when there is no work-start transition at all', async () => {
    const { user, project, token } = await seedOwner();
    const issueId = await insertIssue({ projectId: project.id, createdById: user.id });
    await harness.db.execute(
      sql`UPDATE issues SET created_at = ${daysAgo(10)}::timestamptz WHERE id = ${issueId}`,
    );
    await insertActivity({
      issueId,
      actorId: user.id,
      action: 'issue.statusChanged',
      payload: { from: 'in_progress', to: 'closed' },
      createdAt: daysAgo(4),
    });

    expect(await cycleDays(token, project.slug)).toBeCloseTo(6, 1);
  });

  it('measures from the FIRST work-start when an issue re-entered in_progress', async () => {
    const { user, project, token } = await seedOwner();
    const issueId = await insertIssue({ projectId: project.id, createdById: user.id });

    for (const at of [daysAgo(20), daysAgo(10), daysAgo(5)]) {
      await insertActivity({
        issueId,
        actorId: user.id,
        action: 'issue.statusChanged',
        payload: { from: 'approved', to: 'in_progress' },
        createdAt: at,
      });
    }
    await insertActivity({
      issueId,
      actorId: user.id,
      action: 'issue.statusChanged',
      payload: { from: 'in_progress', to: 'closed' },
      createdAt: daysAgo(2),
    });

    expect(await cycleDays(token, project.slug)).toBeCloseTo(18, 1);
  });

  it('treats a transition into approved as a work-start', async () => {
    const { user, project, token } = await seedOwner();
    const issueId = await insertIssue({ projectId: project.id, createdById: user.id });
    await insertActivity({
      issueId,
      actorId: user.id,
      action: 'issue.statusChanged',
      payload: { from: 'open', to: 'approved' },
      createdAt: daysAgo(9),
    });
    await insertActivity({
      issueId,
      actorId: user.id,
      action: 'issue.statusChanged',
      payload: { from: 'approved', to: 'awaiting_release' },
      createdAt: daysAgo(3),
    });

    expect(await cycleDays(token, project.slug)).toBeCloseTo(6, 1);
  });

  it('counts closed, released and awaiting_release alike as completions', async () => {
    const { user, project, token } = await seedOwner();
    const spans: Array<[string, number, number]> = [
      ['closed', 14, 2],
      ['released', 12, 2],
      ['awaiting_release', 10, 2],
    ];
    let seq = 1;
    for (const [to, startedDaysAgo, completedDaysAgo] of spans) {
      const issueId = await insertIssue({
        projectId: project.id,
        createdById: user.id,
        issSeq: seq,
      });
      seq += 1;
      await insertActivity({
        issueId,
        actorId: user.id,
        action: 'issue.statusChanged',
        payload: { from: 'approved', to: 'in_progress' },
        createdAt: daysAgo(startedDaysAgo),
      });
      await insertActivity({
        issueId,
        actorId: user.id,
        action: 'issue.statusChanged',
        payload: { from: 'in_progress', to },
        createdAt: daysAgo(completedDaysAgo),
      });
    }

    expect(await cycleDays(token, project.slug)).toBeCloseTo(10, 1);
  });

  it('counts two completions on one issue twice, each measured from the same work-start', async () => {
    const { user, project, token } = await seedOwner();
    const issueId = await insertIssue({ projectId: project.id, createdById: user.id });
    await insertActivity({
      issueId,
      actorId: user.id,
      action: 'issue.statusChanged',
      payload: { from: 'approved', to: 'in_progress' },
      createdAt: daysAgo(12),
    });
    for (const at of [daysAgo(6), daysAgo(2)]) {
      await insertActivity({
        issueId,
        actorId: user.id,
        action: 'issue.statusChanged',
        payload: { from: 'in_progress', to: 'closed' },
        createdAt: at,
      });
    }

    expect(await cycleDays(token, project.slug)).toBeCloseTo(8, 1);
  });
});

describe('what the rollup costs and what it no longer serves', () => {
  it('answers 200 to ten concurrent requests against one pool', async () => {
    const { user, project, token } = await seedOwner();
    for (let i = 1; i <= 5; i += 1) {
      const issueId = await insertIssue({
        projectId: project.id,
        createdById: user.id,
        issSeq: i,
      });
      await insertActivity({
        issueId,
        actorId: user.id,
        action: 'issue.statusChanged',
        payload: { from: 'in_progress', to: 'closed' },
      });
    }

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.request('/api/projects/health', {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
    );

    expect(results.map((r) => r.status)).toEqual(Array.from({ length: 10 }, () => 200));
    for (const res of results) {
      const body = (await res.json()) as Array<{ projectSlug: string; throughput: number }>;
      expect(body.find((r) => r.projectSlug === project.slug)?.throughput).toBe(5);
    }
  });

  it('serves no projectMeta even when the project carries an agentConfig', async () => {
    const { project, token } = await seedOwner();
    await harness.db.execute(
      sql`UPDATE projects SET agent_config = '{"mcpServers":{"token":"s3cr3t"}}'::jsonb WHERE id = ${project.id}`,
    );

    const res = await app.request('/api/projects/health', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('projectMeta');
    expect(text).not.toContain('s3cr3t');
  });
});
