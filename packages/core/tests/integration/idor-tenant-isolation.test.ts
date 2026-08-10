import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  type TestUser,
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// ISS-492 — tenant-isolation regression suite. Each of the 4 IDOR endpoints
// gated membership on a caller-supplied projectId while reading a separately-
// supplied issueId/deviceId that was never cross-checked. The pattern below
// proves, on a real Postgres, that a member of project A can no longer read
// project B's content/liveness by supplying a foreign resource id — while the
// in-scope (own-project) path keeps working.

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

describe('ISS-492 — cross-tenant IDOR isolation', () => {
  let harness: TestDatabase;
  let app: Hono<AppVars>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV = 'test';

    const { promptRoutes } = await import('../../src/prompt/routes.js');
    const { agentSessionRoutes } = await import('../../src/agent-sessions/routes.js');
    const { usageRecordRoutes } = await import('../../src/usage-records/routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    const jwtMod = await import('../../src/auth/jwt.js');
    signUserToken = jwtMod.signUserToken;

    app = new Hono<AppVars>();
    app.use('*', requestId());
    app.route('/api/prompts', promptRoutes);
    app.route('/api/agent-sessions', agentSessionRoutes);
    app.route('/api/usage-records', usageRecordRoutes);
    app.onError(errorHandler);
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function verifiedUser(): Promise<TestUser> {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    return user;
  }

  async function req(path: string, userId: string, init: RequestInit = {}) {
    const token = await signUserToken(userId);
    return app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  }

  async function seedIssue(projectId: string, createdBy: string, title: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, created_by_id)
      VALUES (${id}, ${projectId}, ${title}, 'open', ${createdBy})
    `);
    return id;
  }

  async function seedSession(args: {
    projectId: string;
    deviceId: string;
    title: string;
  }): Promise<string> {
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status)
      VALUES (${runId}, ${args.projectId}, 'interactive', 'running')
    `);
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, title, status, messages)
      VALUES (${id}, ${args.projectId}, ${args.deviceId}, ${runId}, ${args.title}, 'idle',
              ${sql`'[{"role":"user","content":"SECRET-LEAK-CANARY"}]'::jsonb`})
    `);
    return id;
  }

  /** A runner row binding a device to a project (device-pool source of truth). */
  async function seedRunner(projectId: string, deviceId: string): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, host, device_id, name, status)
      VALUES (${randomUUID()}, ${projectId}, 'claude-code', 'device', ${deviceId},
              ${`runner-${deviceId.slice(0, 8)}`}, 'online')
    `);
  }

  /** userA ∈ projA, userB ∈ projB — disjoint orgs/projects/members. */
  async function twoTenants() {
    const userA = await verifiedUser();
    const userB = await verifiedUser();
    const orgA = await seedOrg(harness.db, userA.id, { isPersonal: false });
    const orgB = await seedOrg(harness.db, userB.id, { isPersonal: false });
    const projA = await createTestProject(harness.db, userA.id, { orgId: orgA.id });
    const projB = await createTestProject(harness.db, userB.id, { orgId: orgB.id });
    await createTestProjectMember(harness.db, { userId: userA.id, projectId: projA.id });
    await createTestProjectMember(harness.db, { userId: userB.id, projectId: projB.id });
    return { userA, userB, projA, projB };
  }

  // ---- #1 POST /api/prompts/preview ----------------------------------------

  it('#1 preview: foreign issueId → 404; in-project issueId → 200 with snapshot', async () => {
    const { userA, projA, projB } = await twoTenants();
    const foreignIssue = await seedIssue(projB.id, projB.createdBy, 'victim issue body');
    const ownIssue = await seedIssue(projA.id, projA.createdBy, 'own issue body');

    const leak = await req('/api/prompts/preview', userA.id, {
      method: 'POST',
      body: JSON.stringify({ projectId: projA.id, state: 'code', issueId: foreignIssue }),
    });
    expect(leak.status).toBe(404);
    expect(await leak.text()).not.toContain('victim issue body');

    const ok = await req('/api/prompts/preview', userA.id, {
      method: 'POST',
      body: JSON.stringify({ projectId: projA.id, state: 'code', issueId: ownIssue }),
    });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { userPrompt: string };
    expect(okBody.userPrompt).toContain('own issue body');
  });

  // ---- #2 GET /api/agent-sessions?deviceId= --------------------------------

  it('#2 sessions: foreign deviceId → []; own device → own sessions', async () => {
    const { userA, userB, projA, projB } = await twoTenants();
    const deviceA = await createTestDevice(harness.db, userA.id);
    const deviceB = await createTestDevice(harness.db, userB.id);
    await seedSession({ projectId: projA.id, deviceId: deviceA.id, title: 'A session' });
    await seedSession({ projectId: projB.id, deviceId: deviceB.id, title: 'B session' });

    // userA probing project B's device → no rows, no canary leak.
    const foreign = await req(`/api/agent-sessions?deviceId=${deviceB.id}`, userA.id);
    expect(foreign.status).toBe(200);
    const foreignBody = (await foreign.json()) as unknown[];
    expect(foreignBody).toHaveLength(0);
    const foreignRaw = JSON.stringify(foreignBody);
    expect(foreignRaw).not.toContain('SECRET-LEAK-CANARY');
    expect(foreignRaw).not.toContain('B session');

    // userA listing their own device → their session is returned.
    const own = await req(`/api/agent-sessions?deviceId=${deviceA.id}`, userA.id);
    expect(own.status).toBe(200);
    const ownBody = (await own.json()) as Array<{ title: string }>;
    expect(ownBody.map((s) => s.title)).toContain('A session');
  });

  // ---- #3 GET /api/agent-sessions/desktop/status ---------------------------

  it('#3 desktop/status: unrelated tenant gets non-revealing connected:false', async () => {
    const { userA, userB, projB } = await twoTenants();
    const deviceB = await createTestDevice(harness.db, userB.id, { status: 'online' });
    await seedRunner(projB.id, deviceB.id);

    // Foreign deviceId — online device in project B, but userA is unrelated.
    const byDevice = await req(`/api/agent-sessions/desktop/status?deviceId=${deviceB.id}`, userA.id);
    expect(byDevice.status).toBe(200);
    expect(await byDevice.json()).toEqual({ data: { connected: false } });

    // Foreign projectSlug — no membership → no slug-existence/liveness oracle.
    const bySlug = await req(
      `/api/agent-sessions/desktop/status?projectSlug=${projB.slug}`,
      userA.id,
    );
    expect(bySlug.status).toBe(200);
    expect(await bySlug.json()).toEqual({ data: { connected: false } });

    // Device owner sees the real liveness bit.
    const owner = await req(`/api/agent-sessions/desktop/status?deviceId=${deviceB.id}`, userB.id);
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual({ data: { connected: true } });
  });

  // ---- #4 usage-records null-projectId pool --------------------------------

  it('#4 usage-records: null-projectId GET → 404 and POST → 400', async () => {
    const { userA } = await twoTenants();

    const nullRecordId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO usage_records (id, project_id, source, model, input_tokens, output_tokens, recorded_at)
      VALUES (${nullRecordId}, NULL, 'cli', 'claude-opus-4-8', 10, 20, now())
    `);

    const read = await req(`/api/usage-records/${nullRecordId}`, userA.id);
    expect(read.status).toBe(404);

    const create = await req('/api/usage-records', userA.id, {
      method: 'POST',
      body: JSON.stringify({ source: 'cli', model: 'claude-opus-4-8', inputTokens: 1, outputTokens: 2 }),
    });
    expect(create.status).toBe(400);
  });
});
