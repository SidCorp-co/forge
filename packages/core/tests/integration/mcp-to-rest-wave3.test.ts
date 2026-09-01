/**
 * ISS-894 wave 3 — the REST routes written so four more MCP tools could go.
 *
 * Two of these had no route at all before (`forge_skills.pin`, and the WRITE
 * half of `forge_ux_findings`), which is why they are here rather than in the
 * wave-2 file: the tool was the only way to perform the write, so nothing on
 * this surface had ever been exercised.
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

  const [health, charter, targets, batch, ux, collab, pin, uxw, jwt, err] = await Promise.all([
    import('../../src/health/routes.js'),
    import('../../src/skills/divergence-charter-routes.js'),
    import('../../src/integrations/target-routes.js'),
    import('../../src/release-batch/routes.js'),
    import('../../src/projects/ux-contract-routes.js'),
    import('../../src/projects/collaborators-routes.js'),
    import('../../src/skills/pin-routes.js'),
    import('../../src/ux-findings/write-routes.js'),
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
  app.route('/api/projects', uxw.uxFindingWriteRoutes);
  app.route('/api/projects', charter.divergenceCharterRoutes);
  app.route('/api/projects', targets.integrationTargetRoutes);
  app.route('/api/projects', batch.releaseBatchRoutes);
  app.route('/api/projects', ux.uxContractProjectRoutes);
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

// cm:guard a project role BELOW admin only exists for someone who is not the org owner — `effectiveProjectRole` is org-aware and hands the org owner implicit project admin, so seeding role:'member' on the project creator produces an admin and every negative role case passes for the wrong reason.
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

  // cm:guard the whole surface of this route is OTHER PEOPLE's user rows, and `users` carries `passwordHash` on the same row — so a projection that ever became a `select()` would answer a people-search with credentials. Assert the absence by name rather than trusting the service's own guard, because this is the route that exposes it.
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

  // cm:guard the seed is load-bearing: with no `project_members` row anywhere this route answers `{users:[],total:0}` however broken the scoping is, so an unseeded version of this case cannot fail. And `listCollaborators` guards a zero-visibility caller TWICE over — the early return and the `inArray` on the candidate query — each sufficient alone, so deleting either one changes nothing and this stays green. Measured both ways. That means a green here is NOT evidence a given line is dead; it takes both gone before the stranger is handed another account's row.
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

  // cm:guard the reason is refused HERE, by the schema, and the service ALSO throws — assert the 400 rather than the throw, because the service signals with a raw `Error` whose message starts `BAD_REQUEST:` and that reaches a caller as a 500. A pin with no reason is a permanent divergence nobody can account for later.
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

  // cm:guard a skill that exists but belongs elsewhere must answer 404, not 500 — the UPDATE is keyed on (id, projectId) so it matches nothing and the service throws a raw `NOT_FOUND:` Error. 404 is also what stops the route being used to probe which skill ids exist in projects the caller cannot see.
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

describe('POST /api/projects/:id/ux-findings', () => {
  async function seedIssue(projectId: string, userId: string, seq: number) {
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${issueId}, ${projectId}, ${seq}, 'ux fixture', 'open', ${userId})`);
    return issueId;
  }

  const finding = (issueId: string, over: Record<string, unknown> = {}) => ({
    issueId,
    stage: 'review',
    kind: 'a11y',
    detail: 'the empty-search state has no announced role',
    ...over,
  });

  it('records a finding against an issue in the project', async () => {
    const { project, token, user } = await seed();
    const issueId = await seedIssue(project.id, user.id, 900);

    const res = await call(`/api/projects/${project.id}/ux-findings`, token, {
      method: 'POST',
      body: JSON.stringify(finding(issueId)),
    });
    expect(res.status).toBe(201);

    const rows = await harness.db.execute(
      sql`SELECT issue_id, run_id, kind, severity FROM ux_findings WHERE project_id = ${project.id}`,
    );
    expect(rows[0]).toMatchObject({ issue_id: issueId, run_id: null, kind: 'a11y' });
    expect((rows[0] as { severity: string }).severity).toBe('must');
  });

  // cm:guard 404 and NOT 403 — membership was already proven, so a different status for "exists elsewhere" versus "does not exist" is the only thing it could reveal. Seeded in a real second project rather than a random uuid, because a random uuid is absent from every project and cannot tell the two answers apart.
  it('refuses an issue that belongs to a different project, without saying it exists', async () => {
    const { project, token } = await seed();
    const other = await seed();
    const foreignIssue = await seedIssue(other.project.id, other.user.id, 901);

    const res = await call(`/api/projects/${project.id}/ux-findings`, token, {
      method: 'POST',
      body: JSON.stringify(finding(foreignIssue)),
    });
    expect(res.status).toBe(404);

    const rows = await harness.db.execute(sql`SELECT id FROM ux_findings`);
    expect(rows.length).toBe(0);
  });

  // cm:guard the ruleId is DROPPED to null, not refused: a stale id from another project would FK-fail the insert and lose a real finding the agent had no way to validate first. The finding is what is worth keeping; the rule link is not.
  it('keeps the finding and drops a ruleId that belongs elsewhere', async () => {
    const { project, token, user } = await seed();
    const issueId = await seedIssue(project.id, user.id, 902);

    const res = await call(`/api/projects/${project.id}/ux-findings`, token, {
      method: 'POST',
      body: JSON.stringify(finding(issueId, { ruleId: randomUUID() })),
    });
    expect(res.status).toBe(201);

    const rows = await harness.db.execute(sql`SELECT rule_id FROM ux_findings`);
    expect(rows[0]).toMatchObject({ rule_id: null });
  });

  it('refuses a caller who is not a project member', async () => {
    const { project, user } = await seed();
    const issueId = await seedIssue(project.id, user.id, 903);
    const stranger = await verifiedUser();

    const res = await call(`/api/projects/${project.id}/ux-findings`, stranger.token, {
      method: 'POST',
      body: JSON.stringify(finding(issueId)),
    });
    expect(res.status).toBe(403);
  });
});
