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

// GET /api/runners/active?projectId= — the live per-runner execution snapshot
// powering the dashboard "Active runners" card + the Runners-screen "running
// ISS-X" line. Exercises the real SQL against Postgres via an in-process
// `app.request` (mirrors dependency-routes-e2e — no network server): a runner
// with a dispatched job surfaces `current` (issue ref + stage); an idle runner
// is null; a job under a TERMINAL pipeline_run (orphan) leaves its runner idle
// rather than dropping it from the result (ISS-258 join-side filter).
type Mods = {
  runnerRoutes: typeof import('../../src/runners/routes.js').runnerRoutes;
  signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  errorHandler: typeof import('../../src/middleware/error.js').errorHandler;
};

describe('GET /api/runners/active', () => {
  let harness: TestDatabase;
  let mods: Mods;
  // biome-ignore lint/suspicious/noExplicitAny: test-only mount
  let app: any;

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

    const [routesMod, jwtMod, errMod] = await Promise.all([
      import('../../src/runners/routes.js'),
      import('../../src/auth/jwt.js'),
      import('../../src/middleware/error.js'),
    ]);
    mods = {
      runnerRoutes: routesMod.runnerRoutes,
      signUserToken: jwtMod.signUserToken,
      errorHandler: errMod.errorHandler,
    };
    app = new Hono();
    app.route('/api/runners', mods.runnerRoutes);
    app.onError(mods.errorHandler);
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seed() {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'admin',
    });
    return { user, project };
  }

  async function insertRunner(projectId: string, name: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, host, device_id, name, capabilities, status, last_seen_at)
      VALUES (${id}, ${projectId}, 'claude-code', 'remote', NULL, ${name}, '{}'::jsonb, 'online', now())
    `);
    return id;
  }

  async function insertIssue(projectId: string, issSeq: number): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (${id}, ${projectId}, ${issSeq}, ${`Issue ${issSeq}`}, 'in_progress', 'medium',
        (SELECT created_by FROM projects WHERE id = ${projectId}))
    `);
    return id;
  }

  async function insertRun(projectId: string, issueId: string, status: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${id}, ${projectId}, ${issueId}, 'issue', ${status}, now())
    `);
    return id;
  }

  async function insertJob(
    projectId: string,
    args: { issueId: string; runnerId: string; type: string; runId: string },
  ): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, type, status, runner_id, pipeline_run_id,
        payload, queued_at, dispatched_at, created_by)
      VALUES (${randomUUID()}, ${projectId}, ${args.issueId}, ${args.type}, 'running',
        ${args.runnerId}, ${args.runId}, '{}'::jsonb, now(), now(),
        (SELECT created_by FROM projects WHERE id = ${projectId}))
    `);
  }

  async function call(projectId: string, jwt: string) {
    const res = await app.request(
      `/api/runners/active?projectId=${encodeURIComponent(projectId)}`,
      { headers: { authorization: `Bearer ${jwt}` } },
    );
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }

  it('reports a busy runner with its issue ref + stage, and an idle runner as null', async () => {
    const { user, project } = await seed();
    const jwt = await mods.signUserToken(user.id);

    const busyRunner = await insertRunner(project.id, 'busy-runner');
    const idleRunner = await insertRunner(project.id, 'idle-runner');
    const issue = await insertIssue(project.id, 417);
    const run = await insertRun(project.id, issue, 'running');
    await insertJob(project.id, { issueId: issue, runnerId: busyRunner, type: 'code', runId: run });

    const { status, body } = await call(project.id, jwt);
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.busy).toBe(1);

    const busy = body.runners.find((r: any) => r.runnerId === busyRunner);
    expect(busy.current).toMatchObject({ stage: 'code', issueRef: 'ISS-417' });
    expect(busy.current.startedAt).toBeTruthy();

    const idle = body.runners.find((r: any) => r.runnerId === idleRunner);
    expect(idle.current).toBeNull();
  });

  it('counts a job under a PAUSED pipeline_run as busy (paused is non-terminal)', async () => {
    const { user, project } = await seed();
    const jwt = await mods.signUserToken(user.id);

    const runner = await insertRunner(project.id, 'paused-runner');
    const issue = await insertIssue(project.id, 88);
    // A paused run is non-terminal — its job still holds the runner.
    const run = await insertRun(project.id, issue, 'paused');
    await insertJob(project.id, { issueId: issue, runnerId: runner, type: 'review', runId: run });

    const { status, body } = await call(project.id, jwt);
    expect(status).toBe(200);
    expect(body.busy).toBe(1);
    expect(body.runners[0].current).toMatchObject({ stage: 'review', issueRef: 'ISS-88' });
  });

  it('treats a job under a terminal pipeline_run as idle (orphan filter, ISS-258)', async () => {
    const { user, project } = await seed();
    const jwt = await mods.signUserToken(user.id);

    const runner = await insertRunner(project.id, 'orphan-runner');
    const issue = await insertIssue(project.id, 9);
    // Parent run already completed → the still-"running" job is an orphan.
    const run = await insertRun(project.id, issue, 'completed');
    await insertJob(project.id, { issueId: issue, runnerId: runner, type: 'fix', runId: run });

    const { status, body } = await call(project.id, jwt);
    expect(status).toBe(200);
    // Runner is still listed (not dropped), but idle — its only job is an orphan.
    expect(body.total).toBe(1);
    expect(body.busy).toBe(0);
    expect(body.runners[0].current).toBeNull();
  });

  it('403s a non-member', async () => {
    const { project } = await seed();
    const stranger = await createTestUser(harness.db);
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${stranger.id}`,
    );
    const jwt = await mods.signUserToken(stranger.id);
    const { status } = await call(project.id, jwt);
    expect(status).toBe(403);
  });
});
