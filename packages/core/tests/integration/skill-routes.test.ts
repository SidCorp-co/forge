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

// Phase 2.5-F2 integration — skill sync (device) + register-to-stage (user).
// Uses real Postgres (testcontainer pgvector/pgvector:pg17) + real HTTP via
// Hono's fetch-compat app. Device tokens are issued via the real
// `issueDeviceToken` helper so `requireDevice` middleware actually verifies.

describe('F2 skill routes integration', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let issueDeviceToken: typeof import('../../src/auth/deviceToken.js').issueDeviceToken;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  let hooksModule: typeof import('../../src/pipeline/hooks.js');

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

    const { skillSyncRoutes, skillRegisterRoutes } = await import('../../src/skills/routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    hooksModule = await import('../../src/pipeline/hooks.js');
    const deviceTokenMod = await import('../../src/auth/deviceToken.js');
    const jwtMod = await import('../../src/auth/jwt.js');
    issueDeviceToken = deviceTokenMod.issueDeviceToken;
    signUserToken = jwtMod.signUserToken;

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/projects', skillSyncRoutes);
    app.route('/api/projects', skillRegisterRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    hooksModule.hooks.reset();
    await emailVerify();
  });

  async function emailVerify() {
    // Default factory leaves email_verified_at null; bulk-verify on truncate.
  }

  async function seedProjectWith(role: 'admin' | 'member' | 'viewer') {
    const user = await createTestUser(harness.db);
    // The register endpoint runs assertEmailVerified — flip the flag on the user.
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role,
    });
    return { user, project };
  }

  // ---------- SYNC ----------

  it('sync: 401 when Authorization header is missing', async () => {
    const { project } = await seedProjectWith('admin');
    const res = await app.request(`/api/projects/${project.id}/skills/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skills: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('sync: inserts on first run, returns added', async () => {
    const { user, project } = await seedProjectWith('admin');
    const { plaintext: deviceToken } = await issueDeviceToken({
      ownerId: user.id,
      name: 'test-device',
      platform: 'linux',
    });

    let emitted: unknown = null;
    hooksModule.hooks.on('skillSynced', (p) => {
      emitted = p;
    });

    const res = await app.request(`/api/projects/${project.id}/skills/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({
        skills: [
          {
            name: 'custom-deploy',
            prompt: 'deploy body',
            tools: ['Read', 'Bash'],
            hash: 'abc12345',
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      added: string[];
      updated: string[];
      unchanged: string[];
      removed: string[];
    };
    expect(body).toEqual({
      added: ['custom-deploy'],
      updated: [],
      unchanged: [],
      removed: [],
    });

    const rows = await harness.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM skills WHERE project_id = ${project.id} AND scope = 'project'`,
    );
    expect((rows[0] as { count: string }).count).toBe('1');

    // Hook emission is fire-and-forget; give the microtask a tick.
    await new Promise((r) => setTimeout(r, 20));
    expect(emitted).toMatchObject({
      projectId: project.id,
      added: ['custom-deploy'],
      updated: [],
      unchanged: [],
      removed: [],
    });
  });

  it('sync: second run with same hash → all unchanged', async () => {
    const { user, project } = await seedProjectWith('admin');
    const { plaintext: deviceToken } = await issueDeviceToken({
      ownerId: user.id,
      name: 'd',
      platform: 'linux',
    });

    const body = {
      skills: [{ name: 'x', prompt: 'p', tools: [], hash: 'h1h1h1h1' }],
    };
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${deviceToken}`,
    };

    await app.request(`/api/projects/${project.id}/skills/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const res = await app.request(`/api/projects/${project.id}/skills/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const got = (await res.json()) as { unchanged: string[]; updated: string[] };
    expect(got.unchanged).toEqual(['x']);
    expect(got.updated).toEqual([]);
  });

  it('sync: hash change → updated', async () => {
    const { user, project } = await seedProjectWith('admin');
    const { plaintext: deviceToken } = await issueDeviceToken({
      ownerId: user.id,
      name: 'd',
      platform: 'linux',
    });
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${deviceToken}`,
    };

    await app.request(`/api/projects/${project.id}/skills/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        skills: [{ name: 'x', prompt: 'old', tools: [], hash: 'old-hash' }],
      }),
    });
    const res = await app.request(`/api/projects/${project.id}/skills/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        skills: [{ name: 'x', prompt: 'new', tools: [], hash: 'new-hash' }],
      }),
    });
    const got = (await res.json()) as { updated: string[] };
    expect(got.updated).toEqual(['x']);
  });

  it('sync: mode=full removes missing skills', async () => {
    const { user, project } = await seedProjectWith('admin');
    const { plaintext: deviceToken } = await issueDeviceToken({
      ownerId: user.id,
      name: 'd',
      platform: 'linux',
    });
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${deviceToken}`,
    };

    // Seed two skills first.
    await app.request(`/api/projects/${project.id}/skills/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        skills: [
          { name: 'a', prompt: 'p', tools: [], hash: 'ha000000' },
          { name: 'b', prompt: 'p', tools: [], hash: 'hb000000' },
        ],
      }),
    });
    // Now sync full with only `a`.
    const res = await app.request(`/api/projects/${project.id}/skills/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mode: 'full',
        skills: [{ name: 'a', prompt: 'p', tools: [], hash: 'ha000000' }],
      }),
    });
    const got = (await res.json()) as { removed: string[] };
    expect(got.removed).toEqual(['b']);
    const countRows = await harness.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM skills WHERE project_id = ${project.id}`,
    );
    expect((countRows[0] as { count: string }).count).toBe('1');
  });

  it('sync: device whose owner is not a project member → 403', async () => {
    const { project } = await seedProjectWith('admin');
    const strangerUser = await createTestUser(harness.db);
    const { plaintext: strangerToken } = await issueDeviceToken({
      ownerId: strangerUser.id,
      name: 'stranger',
      platform: 'linux',
    });

    const res = await app.request(`/api/projects/${project.id}/skills/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${strangerToken}`,
      },
      body: JSON.stringify({ skills: [] }),
    });
    expect(res.status).toBe(403);
  });

  it('sync: duplicate names in one payload → 400', async () => {
    const { user, project } = await seedProjectWith('admin');
    const { plaintext: deviceToken } = await issueDeviceToken({
      ownerId: user.id,
      name: 'd',
      platform: 'linux',
    });
    const res = await app.request(`/api/projects/${project.id}/skills/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({
        skills: [
          { name: 'dup', prompt: 'p', tools: [], hash: 'h1h1h1h1' },
          { name: 'dup', prompt: 'p', tools: [], hash: 'h2h2h2h2' },
        ],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("sync: mode='full' from member-role device → 403", async () => {
    const { project } = await seedProjectWith('admin');
    const memberUser = await createTestUser(harness.db);
    await createTestProjectMember(harness.db, {
      userId: memberUser.id,
      projectId: project.id,
      role: 'member',
    });
    const { plaintext: memberDeviceToken } = await issueDeviceToken({
      ownerId: memberUser.id,
      name: 'member-dev',
      platform: 'linux',
    });
    const res = await app.request(`/api/projects/${project.id}/skills/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${memberDeviceToken}`,
      },
      body: JSON.stringify({ mode: 'full', skills: [] }),
    });
    expect(res.status).toBe(403);
  });

  it('sync: update bumps version + preserves description when omitted', async () => {
    const { user, project } = await seedProjectWith('admin');
    const { plaintext: deviceToken } = await issueDeviceToken({
      ownerId: user.id,
      name: 'd',
      platform: 'linux',
    });
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${deviceToken}`,
    };

    await app.request(`/api/projects/${project.id}/skills/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        skills: [
          {
            name: 'v-skill',
            description: 'original',
            prompt: 'p1',
            tools: [],
            hash: 'h1h1h1h1',
          },
        ],
      }),
    });

    await app.request(`/api/projects/${project.id}/skills/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        // no description on the update
        skills: [{ name: 'v-skill', prompt: 'p2', tools: [], hash: 'h2h2h2h2' }],
      }),
    });

    const rows = await harness.db.execute<{ version: number; description: string }>(
      sql`SELECT version, description FROM skills WHERE project_id = ${project.id} AND name = 'v-skill'`,
    );
    const row = rows[0] as { version: number; description: string };
    expect(Number(row.version)).toBe(2);
    expect(row.description).toBe('original');
  });

  it('sync: payload above 500 skills → 400', async () => {
    const { user, project } = await seedProjectWith('admin');
    const { plaintext: deviceToken } = await issueDeviceToken({
      ownerId: user.id,
      name: 'd',
      platform: 'linux',
    });
    const bulk = Array.from({ length: 501 }, (_, i) => ({
      name: `skill-${i}`,
      prompt: 'p',
      tools: [],
      hash: `${i.toString().padStart(8, '0')}`,
    }));
    const res = await app.request(`/api/projects/${project.id}/skills/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({ skills: bulk }),
    });
    expect(res.status).toBe(400);
  });

  // ---------- REGISTER ----------

  async function seedSkill(projectId: string | null, name = 'r-skill'): Promise<string> {
    const rows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO skills (name, description, scope, project_id, prompt, tools, source, content_hash)
      VALUES (
        ${name},
        'desc',
        ${projectId ? 'project' : 'global'},
        ${projectId},
        'body',
        '[]'::jsonb,
        'user',
        'hash00000000'
      )
      RETURNING id
    `);
    return (rows[0] as { id: string }).id;
  }

  it('register: 401 without token', async () => {
    const { project } = await seedProjectWith('admin');
    const skillId = await seedSkill(project.id);
    const res = await app.request(`/api/projects/${project.id}/skills/${skillId}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'approved' }),
    });
    expect(res.status).toBe(401);
  });

  it('register: 403 when caller is a plain member', async () => {
    const { user, project } = await seedProjectWith('admin');
    // Add a second user as a plain member, act as that user.
    const memberUser = await createTestUser(harness.db);
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${memberUser.id}`,
    );
    await createTestProjectMember(harness.db, {
      userId: memberUser.id,
      projectId: project.id,
      role: 'member',
    });
    const skillId = await seedSkill(project.id);
    const token = await signUserToken(memberUser.id);
    const res = await app.request(`/api/projects/${project.id}/skills/${skillId}/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ stage: 'approved' }),
    });
    expect(res.status).toBe(403);
    void user;
  });

  it('register: owner success, returns registration', async () => {
    const { user, project } = await seedProjectWith('admin');
    const skillId = await seedSkill(project.id);
    const token = await signUserToken(user.id);

    let emitted: unknown = null;
    hooksModule.hooks.on('skillRegistered', (p) => {
      emitted = p;
    });

    const res = await app.request(`/api/projects/${project.id}/skills/${skillId}/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ stage: 'approved' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stage: string | null };
    expect(body.stage).toBe('approved');

    const rows = await harness.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM skill_registrations WHERE project_id = ${project.id}`,
    );
    expect((rows[0] as { count: string }).count).toBe('1');

    await new Promise((r) => setTimeout(r, 20));
    expect(emitted).toMatchObject({
      projectId: project.id,
      skillId,
      actorUserId: user.id,
      stage: 'approved',
    });
  });

  it('register: stage=null clears the registration', async () => {
    const { user, project } = await seedProjectWith('admin');
    const skillId = await seedSkill(project.id);
    const token = await signUserToken(user.id);
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    };

    await app.request(`/api/projects/${project.id}/skills/${skillId}/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ stage: 'approved' }),
    });
    const res = await app.request(`/api/projects/${project.id}/skills/${skillId}/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ stage: null }),
    });
    expect(res.status).toBe(200);
    const countRows = await harness.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM skill_registrations WHERE project_id = ${project.id}`,
    );
    expect((countRows[0] as { count: string }).count).toBe('0');
  });

  it('register: 404 for unknown skill', async () => {
    const { user, project } = await seedProjectWith('admin');
    const token = await signUserToken(user.id);
    const fakeSkillId = '00000000-0000-4000-8000-000000000000';
    const res = await app.request(`/api/projects/${project.id}/skills/${fakeSkillId}/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ stage: 'approved' }),
    });
    expect(res.status).toBe(404);
  });

  it('register: global skill is not directly registrable (must adopt first)', async () => {
    // ISS-388 — global skills are read-only templates. Registering one directly
    // is rejected with 400 SKILL_NOT_PROJECT_SCOPED; the project must adopt the
    // template (clone it into a project-scoped skill) before registering it.
    const { user, project } = await seedProjectWith('admin');
    const globalSkillId = await seedSkill(null, 'forge-plan');
    const token = await signUserToken(user.id);
    const res = await app.request(`/api/projects/${project.id}/skills/${globalSkillId}/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ stage: 'approved' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('SKILL_NOT_PROJECT_SCOPED');
  });

  it('register: admin (non-owner) can register a skill', async () => {
    const { project } = await seedProjectWith('admin');
    const adminUser = await createTestUser(harness.db);
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${adminUser.id}`,
    );
    await createTestProjectMember(harness.db, {
      userId: adminUser.id,
      projectId: project.id,
      role: 'admin',
    });
    const skillId = await seedSkill(project.id);
    const token = await signUserToken(adminUser.id);
    const res = await app.request(`/api/projects/${project.id}/skills/${skillId}/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ stage: 'approved' }),
    });
    expect(res.status).toBe(200);
  });

  it('register: rejects arbitrary stage strings not in IssueStatus enum', async () => {
    const { user, project } = await seedProjectWith('admin');
    const skillId = await seedSkill(project.id);
    const token = await signUserToken(user.id);
    const res = await app.request(`/api/projects/${project.id}/skills/${skillId}/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ stage: 'made-up-stage' }),
    });
    expect(res.status).toBe(400);
  });

  it('register: moving a skill from stage A → B clears the old row', async () => {
    const { user, project } = await seedProjectWith('admin');
    const skillId = await seedSkill(project.id);
    const token = await signUserToken(user.id);
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    };

    await app.request(`/api/projects/${project.id}/skills/${skillId}/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ stage: 'approved' }),
    });
    await app.request(`/api/projects/${project.id}/skills/${skillId}/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ stage: 'developed' }),
    });

    const rows = await harness.db.execute<{ stage: string }>(
      sql`SELECT stage FROM skill_registrations WHERE project_id = ${project.id} AND skill_id = ${skillId}`,
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as { stage: string }).stage).toBe('developed');
    void user;
  });

  it("sync endpoint rejects user JWT (401 'invalid device token')", async () => {
    const { user, project } = await seedProjectWith('admin');
    const userToken = await signUserToken(user.id);
    const res = await app.request(`/api/projects/${project.id}/skills/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ skills: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('register endpoint rejects device token (401 invalid user token)', async () => {
    const { user, project } = await seedProjectWith('admin');
    const { plaintext: deviceToken } = await issueDeviceToken({
      ownerId: user.id,
      name: 'd',
      platform: 'linux',
    });
    const skillId = await seedSkill(project.id);
    const res = await app.request(`/api/projects/${project.id}/skills/${skillId}/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({ stage: 'approved' }),
    });
    expect(res.status).toBe(401);
  });

  it('register: project-scoped skill from different project → 404', async () => {
    const { user, project } = await seedProjectWith('admin');
    // Create a separate project and a skill scoped to it.
    const otherOwner = await createTestUser(harness.db);
    const otherProject = await createTestProject(harness.db, otherOwner.id);
    const foreignSkillId = await seedSkill(otherProject.id, 'foreign');
    const token = await signUserToken(user.id);
    const res = await app.request(`/api/projects/${project.id}/skills/${foreignSkillId}/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ stage: 'approved' }),
    });
    expect(res.status).toBe(404);
  });
});
