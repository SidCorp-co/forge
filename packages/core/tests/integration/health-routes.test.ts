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
 * ISS-267 regression — `GET /api/projects/health` 500'd on staging because the
 * throughput query passed a JS Date through Drizzle's `sql` template, and
 * postgres-js cannot serialize Date instances at Bind time
 * (`ERR_INVALID_ARG_TYPE` from Buffer.byteLength). Mock-based tests never hit
 * the real driver and could not catch it; these run against a real Postgres, so
 * a future Date-binding regression in this handler surfaces here.
 */

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

  it('returns 200 with throughput=0 when there is no activity (regression: no Date binding crash)', async () => {
    const { project, token } = await seedOwner();

    const res = await app.request('/api/projects/health', {
      headers: { authorization: `Bearer ${token}` },
    });

    // cm:why the pre-fix bug threw before any row work, so even an empty project returned 500 — asserting 200 on nothing at all is what locks the binding fix in.
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
      payload: { from: 'tested', to: 'released' },
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
    // cm:why eight days puts this outside the rolling seven-day window by a full day, so a boundary drifting by hours cannot make the case pass by accident.
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await insertActivity({
      issueId,
      actorId: user.id,
      action: 'issue.statusChanged',
      payload: { from: 'tested', to: 'released' },
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

  /**
   * ISS-1018 — the cycle figure, after the correlated `min()` became one CTE pass.
   *
   * `avgCycleTimeDays` averages, over every qualifying completion event in the
   * last seven days, the days from that issue's FIRST transition into
   * `in_progress`/`approved` to the completion. Each case below is a different
   * branch of the same SQL, and every one of them passes against the correlated
   * subquery this replaced — equivalence is what is asserted, not a new figure.
   */

  async function cycleDays(token: string, slug: string): Promise<number | undefined> {
    const res = await app.request('/api/projects/health', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ projectSlug: string; avgCycleTimeDays: number }>;
    return body.find((r) => r.projectSlug === slug)?.avgCycleTimeDays;
  }

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  // cm:guard an issue started weeks before it closed is the commonest shape there is: restrict the work-start side to the seven-day completion window and this case falls back to `issues.createdAt` and reports a number wrong in the same direction every time (ISS-1018).
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

  // cm:guard the COALESCE onto issues.created_at is the ONLY fallback and exists for rows predating the transitions being recorded — a LEFT JOIN turned INNER would drop this issue from the average entirely rather than report it wrong.
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

  // cm:guard the FIRST work-start and not the last: `DISTINCT ON (issue_id) ... ORDER BY issue_id, created_at ASC` is what makes it the first, and flipping that ORDER BY to DESC is the silent way to halve every cycle figure on the dashboard.
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

  // cm:guard `approved` counts as a work-start alongside `in_progress`: an issue whose pipeline moved it straight from approved to closed HAS a work-start, and dropping the second spelling sends it down the createdAt fallback instead.
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

  // cm:guard all THREE completion spellings, each on its own issue with its own span, so the average lands on 10 only if every one was counted — `closed` being the one a criterion naming only `released` and `awaiting_release` would let an implementation drop.
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

    // cm:why (12 + 10 + 8) / 3, so 10 is reachable only with all three spellings present.
    expect(await cycleDays(token, project.slug)).toBeCloseTo(10, 1);
  });

  // cm:guard the average is over COMPLETION EVENTS and not over issues, which is what the correlated subquery did: a rewrite collapsing completions to one row per issue reports 6 or 10 here instead of 8.
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

    // cm:why (6 + 10) / 2 = 8 for two events; collapsing to one would read 6 or 10.
    expect(await cycleDays(token, project.slug)).toBeCloseTo(8, 1);
  });

  // cm:guard the pool is `max: 10` in db/client.ts and one request now fans out ten reads, so this is the case that says the bound is real against a real driver rather than a mock — unbounded, ten overlapping requests ask for a hundred connections.
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

  // cm:guard the response shape against a real serialization rather than a mock: `agentConfig` is free-form jsonb this repo keeps off every MCP read, and it used to ride out on every row of this list as `projectMeta` (ISS-1018).
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
