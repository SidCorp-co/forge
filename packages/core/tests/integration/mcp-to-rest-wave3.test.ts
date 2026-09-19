/**
 * ISS-894 wave 3 — the REST routes written so four more MCP tools could go.
 *
 * One of these had no route at all before (`forge_skills.pin`), which is why it
 * is here rather than in the wave-2 file: the tool was the only way to perform
 * the write, so nothing on this surface had ever been exercised.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestOrgMember,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
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

  const [health, charter, targets, batch, collab, pin, jwt, err] = await Promise.all([
    import('../../src/health/routes.js'),
    import('../../src/skills/divergence-charter-routes.js'),
    import('../../src/integrations/postman/target-routes.js'),
    import('../../src/release-batch/routes.js'),
    import('../../src/projects/collaborators-routes.js'),
    import('../../src/skills/pin-routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
  ]);
  signUserToken = jwt.signUserToken;

  app = new Hono();
  app.route('/', health.publicHealthRoutes);
  app.route('/api/projects', health.opsHealthProjectRoutes);
  app.route('/api/me', health.opsHealthMeRoutes);
  app.route('/api/me', collab.collaboratorsMeRoutes);
  app.route('/api/projects', pin.skillPinRoutes);
  app.route('/api/projects', charter.divergenceCharterRoutes);
  app.route('/api/projects', targets.integrationTargetRoutes);
  app.route('/api/projects', batch.releaseBatchRoutes);
  app.onError(err.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function verifiedUser() {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  return { user, token: await signUserToken(user.id) };
}

async function seed() {
  const { user, token } = await verifiedUser();
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  return { user, project, token };
}

async function seedNonAdminMember(project: { id: string; orgId: string }) {
  const { user, token } = await verifiedUser();
  await createTestOrgMember(harness.db, {
    orgId: project.orgId,
    userId: user.id,
    role: 'member',
  });
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'member',
  });
  return { user, token };
}

function call(path: string, token?: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

describe('GET /api/me/collaborators', () => {
  it('returns the people a caller shares projects with, and their roles', async () => {
    const owner = await verifiedUser();
    const project = await createTestProject(harness.db, owner.user.id);
    const mate = await verifiedUser();
    await createTestOrgMember(harness.db, {
      orgId: project.orgId,
      userId: mate.user.id,
      role: 'member',
    });
    await createTestProjectMember(harness.db, {
      userId: mate.user.id,
      projectId: project.id,
      role: 'member',
    });

    const res = await app.request('/api/me/collaborators', {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      users: Array<{ email: string; memberships: Array<{ projectId: string; role: string }> }>;
    };
    const found = body.users.find((u) => u.email === mate.user.email);
    expect(found?.memberships).toEqual([
      expect.objectContaining({ projectId: project.id, role: 'member' }),
    ]);
  });

  it('never returns an auth secret', async () => {
    const owner = await verifiedUser();
    const project = await createTestProject(harness.db, owner.user.id);
    const mate = await verifiedUser();
    await createTestOrgMember(harness.db, {
      orgId: project.orgId,
      userId: mate.user.id,
      role: 'member',
    });
    await createTestProjectMember(harness.db, {
      userId: mate.user.id,
      projectId: project.id,
      role: 'member',
    });

    const res = await app.request('/api/me/collaborators', {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    const raw = await res.text();
    for (const secret of ['passwordHash', 'password_hash', 'tokenHash']) {
      expect(raw).not.toContain(secret);
    }
  });

  it('shows nobody to a caller who shares no project', async () => {
    const owner = await verifiedUser();
    const project = await createTestProject(harness.db, owner.user.id);
    const mate = await verifiedUser();
    await createTestOrgMember(harness.db, {
      orgId: project.orgId,
      userId: mate.user.id,
      role: 'member',
    });
    await createTestProjectMember(harness.db, {
      userId: mate.user.id,
      projectId: project.id,
      role: 'member',
    });
    const stranger = await verifiedUser();

    const res = await app.request('/api/me/collaborators', {
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { users: unknown[] }).toEqual({ users: [], total: 0 });
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await app.request('/api/me/collaborators')).status).toBe(401);
  });
});

describe('PUT /api/projects/:projectId/skills/:skillId/pin', () => {
  async function seedProjectSkill(projectId: string) {
    const skillId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO skills (id, project_id, scope, name, description, prompt, source,
                          content_hash, skill_md)
      VALUES (${skillId}, ${projectId}, 'project', ${`s-${skillId.slice(0, 8)}`},
              'fixture', 'p', 'manual', ${skillId}, '# body')`);
    return skillId;
  }

  it('pins with a reason and records who declared the divergence', async () => {
    const { project, token } = await seed();
    const skillId = await seedProjectSkill(project.id);

    const res = await call(`/api/projects/${project.id}/skills/${skillId}/pin`, token, {
      method: 'PUT',
      body: JSON.stringify({ pinned: true, reason: 'tenant-specific wording, never rebase' }),
    });
    expect(res.status).toBe(200);

    const row = await harness.db.execute(
      sql`SELECT pinned, pinned_reason, pinned_by FROM skills WHERE id = ${skillId}`,
    );
    expect(row[0]).toMatchObject({
      pinned: true,
      pinned_reason: 'tenant-specific wording, never rebase',
    });
    expect((row[0] as { pinned_by: string | null }).pinned_by).not.toBeNull();
  });

  it('refuses a pin with no reason, as a 400 and not a 500', async () => {
    const { project, token } = await seed();
    const skillId = await seedProjectSkill(project.id);

    const res = await call(`/api/projects/${project.id}/skills/${skillId}/pin`, token, {
      method: 'PUT',
      body: JSON.stringify({ pinned: true }),
    });
    expect(res.status).toBe(400);
  });

  it('unpins without a reason and clears what the pin recorded', async () => {
    const { project, token } = await seed();
    const skillId = await seedProjectSkill(project.id);
    await call(`/api/projects/${project.id}/skills/${skillId}/pin`, token, {
      method: 'PUT',
      body: JSON.stringify({ pinned: true, reason: 'because' }),
    });

    const res = await call(`/api/projects/${project.id}/skills/${skillId}/pin`, token, {
      method: 'PUT',
      body: JSON.stringify({ pinned: false }),
    });
    expect(res.status).toBe(200);
    const row = await harness.db.execute(
      sql`SELECT pinned, pinned_reason, pinned_by, pinned_at FROM skills WHERE id = ${skillId}`,
    );
    expect(row[0]).toMatchObject({ pinned: false, pinned_reason: null, pinned_by: null });
  });

  it('refuses a member who is not an admin', async () => {
    const { project } = await seed();
    const skillId = await seedProjectSkill(project.id);
    const { token } = await seedNonAdminMember(project);

    const res = await call(`/api/projects/${project.id}/skills/${skillId}/pin`, token, {
      method: 'PUT',
      body: JSON.stringify({ pinned: true, reason: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('answers 404 for a skill that belongs to another project', async () => {
    const { project, token } = await seed();
    const other = await seed();
    const foreignSkill = await seedProjectSkill(other.project.id);

    const res = await call(`/api/projects/${project.id}/skills/${foreignSkill}/pin`, token, {
      method: 'PUT',
      body: JSON.stringify({ pinned: true, reason: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});
