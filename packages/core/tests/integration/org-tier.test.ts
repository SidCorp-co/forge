import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  type TestUser,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// Org-tier UX surface, end-to-end on a real Postgres:
//   - org member add: registered user → direct add; unknown email → 202
//     email-token invitation; accept consumes into organization_members
//   - project members direct-add from the org (no email round trip)
//   - move project to another org (org admin on BOTH sides)
//   - GET /orgs/:id/projects in-org transparency
//   - viewer apiKey redaction on the projects list/detail

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

describe('org tier — invitations, direct-add, move, redaction', () => {
  let harness: TestDatabase;
  let app: Hono<AppVars>;
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
    process.env.NODE_ENV = 'test';

    const { orgRoutes } = await import('../../src/orgs/routes.js');
    const { orgInvitationRoutes } = await import('../../src/orgs/invitations-routes.js');
    const { projectRoutes } = await import('../../src/projects/routes.js');
    const { memberRoutes } = await import('../../src/projects/members-routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    const jwtMod = await import('../../src/auth/jwt.js');
    signUserToken = jwtMod.signUserToken;

    app = new Hono<AppVars>();
    app.use('*', requestId());
    app.route('/api/orgs', orgRoutes);
    app.route('/api/org-invitations', orgInvitationRoutes);
    app.route('/api/projects', projectRoutes);
    app.route('/api/projects', memberRoutes);
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
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`,
    );
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

  it('org add-member: registered → direct add; unknown email → invitation; accept consumes', async () => {
    const owner = await verifiedUser();
    const teammate = await verifiedUser();
    const org = await seedOrg(harness.db, owner.id, { isPersonal: false });

    // Registered user → direct add (201)
    const direct = await req(`/api/orgs/${org.id}/members`, owner.id, {
      method: 'POST',
      body: JSON.stringify({ email: teammate.email, role: 'member' }),
    });
    expect(direct.status).toBe(201);

    // Unknown email → 202 invitation (token surfaced in NODE_ENV=test)
    const invited = await req(`/api/orgs/${org.id}/members`, owner.id, {
      method: 'POST',
      body: JSON.stringify({ email: 'newcomer@test.forge.local', role: 'member' }),
    });
    expect(invited.status).toBe(202);
    const invitedBody = (await invited.json()) as { invited: boolean; token?: string };
    expect(invitedBody.invited).toBe(true);
    expect(invitedBody.token).toBeTruthy();

    // Pending invitation listed for admins, token never leaked
    const pending = await req(`/api/orgs/${org.id}/invitations`, owner.id);
    expect(pending.status).toBe(200);
    const pendingRows = (await pending.json()) as Array<Record<string, unknown>>;
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]).not.toHaveProperty('token');

    // Newcomer signs up with the invited email, then accepts
    const newcomer = await createTestUser(harness.db, { email: 'newcomer@test.forge.local' });
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${newcomer.id}`,
    );
    const accept = await req(
      `/api/org-invitations/${invitedBody.token}/accept`,
      newcomer.id,
      { method: 'POST' },
    );
    expect(accept.status).toBe(200);
    expect(await accept.json()).toMatchObject({ orgId: org.id, role: 'member' });

    const members = await req(`/api/orgs/${org.id}/members`, owner.id);
    const memberRows = (await members.json()) as Array<{ userId: string }>;
    expect(memberRows.map((m) => m.userId)).toContain(newcomer.id);

    // Second accept → 410 ALREADY_ACCEPTED
    const again = await req(
      `/api/org-invitations/${invitedBody.token}/accept`,
      newcomer.id,
      { method: 'POST' },
    );
    expect(again.status).toBe(410);
  });

  it('org invitation accept refuses an email mismatch', async () => {
    const owner = await verifiedUser();
    const org = await seedOrg(harness.db, owner.id, { isPersonal: false });

    const invited = await req(`/api/orgs/${org.id}/members`, owner.id, {
      method: 'POST',
      body: JSON.stringify({ email: 'intended@test.forge.local', role: 'admin' }),
    });
    const { token } = (await invited.json()) as { token: string };

    const interloper = await verifiedUser();
    const res = await req(`/api/org-invitations/${token}/accept`, interloper.id, {
      method: 'POST',
    });
    expect(res.status).toBe(403);
  });

  it('project members direct-add works for org members only', async () => {
    const owner = await verifiedUser();
    const orgMate = await verifiedUser();
    const outsider = await verifiedUser();
    const org = await seedOrg(harness.db, owner.id, { isPersonal: false });
    await harness.db.execute(sql`
      INSERT INTO organization_members (org_id, user_id, role)
      VALUES (${org.id}, ${orgMate.id}, 'member')
    `);

    const created = await req('/api/projects', owner.id, {
      method: 'POST',
      body: JSON.stringify({ slug: 'org-proj', name: 'Org Proj', orgId: org.id }),
    });
    expect(created.status).toBe(201);
    const project = (await created.json()) as { id: string };

    // Same-org user → direct add, no email handshake
    const add = await req(`/api/projects/${project.id}/members`, owner.id, {
      method: 'POST',
      body: JSON.stringify({ userId: orgMate.id, role: 'viewer' }),
    });
    expect(add.status).toBe(201);
    expect(await add.json()).toMatchObject({ userId: orgMate.id, role: 'viewer' });

    // Outside the org → 409 NOT_ORG_MEMBER (must use the email invite)
    const refuse = await req(`/api/projects/${project.id}/members`, owner.id, {
      method: 'POST',
      body: JSON.stringify({ userId: outsider.id, role: 'member' }),
    });
    expect(refuse.status).toBe(409);
  });

  it('viewer reads the project but never its apiKey', async () => {
    const owner = await verifiedUser();
    const viewer = await verifiedUser();
    const org = await seedOrg(harness.db, owner.id, { isPersonal: false });

    const created = await req('/api/projects', owner.id, {
      method: 'POST',
      body: JSON.stringify({ slug: 'redact-proj', name: 'Redact', orgId: org.id }),
    });
    const project = (await created.json()) as { id: string; apiKey: string };
    expect(project.apiKey).toBeTruthy();

    await createTestProjectMember(harness.db, {
      userId: viewer.id,
      projectId: project.id,
      role: 'viewer',
    });

    const list = await req('/api/projects', viewer.id);
    const rows = (await list.json()) as Array<{ id: string; apiKey: string | null }>;
    expect(rows.find((r) => r.id === project.id)?.apiKey).toBeNull();

    const detail = await req(`/api/projects/${project.id}`, viewer.id);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { apiKey: string | null }).apiKey).toBeNull();

    // Member+ still receives the key (ADR 0013 unchanged for writers)
    const ownerList = await req('/api/projects', owner.id);
    const ownerRows = (await ownerList.json()) as Array<{ id: string; apiKey: string | null }>;
    expect(ownerRows.find((r) => r.id === project.id)?.apiKey).toBeTruthy();
  });

  it('moves a project to another org (org admin on both sides only)', async () => {
    const owner = await verifiedUser();
    const orgA = await seedOrg(harness.db, owner.id, { isPersonal: false });
    const orgB = await seedOrg(harness.db, owner.id, { isPersonal: false });

    const created = await req('/api/projects', owner.id, {
      method: 'POST',
      body: JSON.stringify({ slug: 'move-proj', name: 'Move', orgId: orgA.id }),
    });
    const project = (await created.json()) as { id: string };

    const moved = await req(`/api/projects/${project.id}`, owner.id, {
      method: 'PATCH',
      body: JSON.stringify({ orgId: orgB.id }),
    });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { orgId: string }).orgId).toBe(orgB.id);

    // Not an admin of the target org → 403
    const stranger = await verifiedUser();
    const orgC = await seedOrg(harness.db, stranger.id, { isPersonal: false });
    const refuse = await req(`/api/projects/${project.id}`, owner.id, {
      method: 'PATCH',
      body: JSON.stringify({ orgId: orgC.id }),
    });
    expect(refuse.status).toBe(403);

    // In-org transparency: org member sees the org's project list
    const listing = await req(`/api/orgs/${orgB.id}/projects`, owner.id);
    expect(listing.status).toBe(200);
    const names = ((await listing.json()) as Array<{ slug: string }>).map((p) => p.slug);
    expect(names).toContain('move-proj');
  });
});
