/**
 * The two declaration forms ISS-824 part 15 adds, through the app against real Postgres: an
 * instance-admin route is refused at the door, ADMIN_ONLY, to a signed-in person off the admin list
 * and answered for one on it, with no check left in its handler; and a route declared by a named
 * rule with a floor is refused at the door below the floor, while one with no floor is answered by
 * its own rule.
 *
 * @direct-test-of packages/core/src/admin/routes.ts
 * @direct-test-of packages/core/src/admin/aggregate-routes.ts
 * @direct-test-of packages/core/src/outbox/routes.ts
 * @direct-test-of packages/core/src/instance-settings/routes.ts
 * @direct-test-of packages/core/src/permissions/declared.ts
 * @direct-test-of packages/core/src/release-batch/routes.ts
 * @direct-test-of packages/core/src/ecosystem/channel-routes.ts
 * @direct-test-of packages/core/src/release-batch/declarations.ts
 * @direct-test-of packages/core/src/middleware/declared-gate.ts
 * @direct-test-of packages/core/src/agent-sessions/session-access.ts
 * @direct-test-of packages/core/src/assistant/conversation-declarations.ts
 * @direct-test-of packages/core/src/assistant/agreement/agreement-door.ts
 * @direct-test-of packages/core/src/assistant/conversation-routes.ts
 * @direct-test-of packages/core/src/assistant/conversation-scope.ts
 * @direct-test-of packages/core/src/agent-sessions/routes.ts
 * @direct-test-of packages/core/src/pipeline/phase-routes.ts
 * @direct-test-of packages/core/src/pipeline/runs-routes.ts
 * @direct-test-of packages/core/src/pipeline/analytics-routes.ts
 * @direct-test-of packages/core/src/integration-door/github-callback-rules.ts
 * @direct-test-of packages/core/src/integration-door/github-connect-routes.ts
 * @direct-test-of packages/core/src/ecosystem/ecosystem-declarations.ts
 * @direct-test-of packages/core/src/ecosystem/contract/routes.ts
 * @direct-test-of packages/core/src/ecosystem/standing/routes.ts
 * @direct-test-of packages/core/src/orgs/routes.ts
 * @direct-test-of packages/core/src/projects/routes.ts
 * @direct-test-of packages/core/src/status-reports/routes.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const OPERATOR = 'operator@declared-admin.test';
// env is read once, on first use: the operator list is set before anything imports it
vi.hoisted(() => {
  process.env.ADMIN_EMAILS = 'operator@declared-admin.test';
});

import { db } from '../../src/db/client.js';
import { signConnectState } from '../../src/integrations/github/index.js';
import { api, type Body, userToken } from '../helpers/api.js';
import {
  type EcosystemWorld,
  formEcosystem,
  openWorld,
  sender,
  testEnv,
  writeInterfaces,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

const tokens = { operator: '', person: '' };

const codeOf = (body: Body) => {
  const error = body.error as { code?: string; refusals?: { code: string }[] } | undefined;
  return error?.code ?? error?.refusals?.[0]?.code ?? JSON.stringify(body);
};

beforeAll(async () => {
  testEnv();
  tokens.operator = await userToken((await createTestUser({ email: OPERATOR, verified: true })).id);
  tokens.person = await userToken((await createTestUser({ verified: true })).id);
}, 120_000);

describe('an instance-admin route is checked at the door, from the admin list', () => {
  it.each([
    '/api/admin/overview',
    '/api/admin/projects',
    '/api/admin/alerts',
    '/api/admin/outbox/dead',
    '/api/admin/instance-settings',
  ])('refuses %s to a person off the list, ADMIN_ONLY, and answers the operator', async (route) => {
    const refused = await api(tokens.person, 'GET', route);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(codeOf(refused.body)).toBe('ADMIN_ONLY');
    const answered = await api(tokens.operator, 'GET', route);
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  });

  it('refuses before the input is read: a bad query from a non-admin is ADMIN_ONLY, not invalid', async () => {
    const refused = await api(tokens.person, 'GET', '/api/admin/overview?window=never');
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    const invalid = await api(tokens.operator, 'GET', '/api/admin/overview?window=never');
    expect(invalid.status, JSON.stringify(invalid.body)).toBe(400);
  });

  it("answers whoami to anyone signed in, as the caller's own standing", async () => {
    const person = await api(tokens.person, 'GET', '/api/admin/whoami');
    expect(person.status).toBe(200);
    expect(person.body.isAdmin).toBe(false);
    const operator = await api(tokens.operator, 'GET', '/api/admin/whoami');
    expect(operator.body.isAdmin).toBe(true);
  });
});

describe('a route declared by a named rule with a floor (POST release-batches)', () => {
  it('refuses a caller with no role at the door, naming the floor, before the cut rule runs', async () => {
    const owner = (await createTestUser({ verified: true })).id;
    const project = await createTestProject(owner);
    const refused = await api(
      tokens.person,
      'POST',
      `/api/projects/${project.id}/release-batches`,
      {
        issueIds: [],
      },
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    // the floor's own answer: requireMasterAct alone would name project.admin
    expect(JSON.stringify(refused.body)).toContain('project.read');
    expect(JSON.stringify(refused.body)).not.toContain('project.admin');
  });
});

describe('a route declared by a named rule with no floor (the channel)', () => {
  it("answers a no-role caller's inbox read by the role rule's own detail, which no door check replaces", async () => {
    const owner = (await createTestUser({ verified: true })).id;
    const project = await createTestProject(owner);
    const refused = await api(tokens.person, 'GET', `/api/projects/${project.id}/channel/inbox`);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(JSON.stringify(refused.body)).toContain('holds no role on project');
  });
});

describe('the session list, declared by its extracted rule (sessionListScope)', () => {
  it('refuses a project the caller holds no role on, and answers its owner', async () => {
    const owner = (await createTestUser({ verified: true })).id;
    const project = await createTestProject(owner);
    const route = `/api/agent-sessions?projectId=${project.id}`;
    const refused = await api(tokens.person, 'GET', route);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(JSON.stringify(refused.body)).toContain('project.read');
    const answered = await api(await userToken(owner), 'GET', route);
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  });

  it('answers a listing across projects with an empty page to a caller who sees none', async () => {
    const listed = await api(tokens.person, 'GET', '/api/agent-sessions');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.total).toBe(0);
  });
});

describe('a conversation route declared by its room rule (readableConversation), no floor', () => {
  it("refuses a project member who is not one of a one-to-one room's people, and answers its participant", async () => {
    const owner = (await createTestUser({ verified: true })).id;
    const ownerToken = await userToken(owner);
    const project = await createTestProject(owner);
    const member = (await createTestUser({ verified: true })).id;
    await addProjectMember(project.id, member, 'member');

    const opened = await api(ownerToken, 'POST', '/api/conversations', {
      projectId: project.id,
      title: 'one to one',
      people: [],
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const roomId = (opened.body as { id: string }).id;

    // the member holds project.read, so no door permission on the project would refuse them: the
    // room's own rule does, naming that they are not in it
    const refused = await api(await userToken(member), 'GET', `/api/conversations/${roomId}`);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(JSON.stringify(refused.body)).toContain('not one of its people');

    const answered = await api(ownerToken, 'GET', `/api/conversations/${roomId}`);
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect((answered.body as { id: string }).id).toBe(roomId);

    // the pin is declared by the same rule: a reader pins, and the member outside the room does not
    const unpinned = await api(await userToken(member), 'PUT', `/api/conversations/${roomId}/pin`);
    expect(unpinned.status, JSON.stringify(unpinned.body)).toBe(403);
    const pinned = await api(ownerToken, 'PUT', `/api/conversations/${roomId}/pin`);
    expect(pinned.status, JSON.stringify(pinned.body)).toBe(200);
  });
});

describe("a pipeline run's routes, declared resolved on the run's project", () => {
  it('answers a reader the phases, refuses them the pause (project.write), and refuses a stranger', async () => {
    const owner = (await createTestUser({ verified: true })).id;
    const project = await createTestProject(owner);
    const viewer = (await createTestUser({ verified: true })).id;
    await addProjectMember(project.id, viewer, 'viewer');
    const runId = randomUUID();
    await db.execute(
      sql`INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${runId}, ${project.id}, 'interactive', 'running')`,
    );
    const viewerToken = await userToken(viewer);

    const read = await api(viewerToken, 'GET', `/api/pipeline-runs/${runId}/phases`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const paused = await api(viewerToken, 'POST', `/api/pipeline-runs/${runId}/pause`);
    expect(paused.status, JSON.stringify(paused.body)).toBe(403);
    expect(JSON.stringify(paused.body)).toContain('project.write');
    const stranger = await api(tokens.person, 'GET', `/api/pipeline-runs/${runId}/resume-point`);
    expect(stranger.status, JSON.stringify(stranger.body)).toBe(403);
  });

  it("reads analytics over the caller's visible projects only: another project's reads as empty", async () => {
    const owner = (await createTestUser({ verified: true })).id;
    const project = await createTestProject(owner);
    const res = await api(tokens.person, 'GET', `/api/pipeline/throughput?projectId=${project.id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('a GitHub return declared by its stranding rule (installCallbackStrand), no floor', () => {
  it('lands a person with their own state but no org.admin on the stranded page naming why, never a JSON refusal', async () => {
    const userId = (await createTestUser({ verified: true })).id;
    const token = await userToken(userId);
    const state = signConnectState(process.env.JWT_SECRET as string, {
      userId,
      orgId: randomUUID(),
    });
    const res = await api(
      token,
      'GET',
      `/api/integrations/github/installed?installation_id=77&code=oauth-code&state=${encodeURIComponent(state)}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(302);
    const where = new URL(res.headers.get('location') as string);
    expect(where.pathname).toBe('/integrations');
    expect(where.searchParams.get('connect')).toBe('not_admin');
  });
});

describe('a contract route declared by its counterparty rule (contractReader), no floor', () => {
  let w: EcosystemWorld;
  beforeAll(async () => {
    w = await openWorld();
    await formEcosystem(w);
    await writeInterfaces(w);
  }, 120_000);

  it('refuses a stranger by the rule and answers a counterparty in the ecosystem the approved versions', async () => {
    const path = `/api/projects/${w.project.forge}/contracts/forge-api/versions`;
    const stranger = await api(tokens.person, 'GET', path);
    expect(stranger.status, JSON.stringify(stranger.body)).toBe(403);
    expect(JSON.stringify(stranger.body)).toMatch(/published to/);

    const party = await sender(w)('store', 'GET', path);
    expect(party.status, JSON.stringify(party.json)).toBe(200);
    expect(party.json.reader.access).toBe('party');
    expect(
      party.json.versions.map((v: { contractVersion: string }) => v.contractVersion),
    ).toContain('2026-09-20');
  });

  it('reads contract standing to a role on the project only, refusing a counterparty with none', async () => {
    const path = `/api/projects/${w.project.forge}/contract-standing`;
    const party = await sender(w)('store', 'GET', path);
    expect(party.status, JSON.stringify(party.json)).toBe(403);
    const member = await sender(w)('platform', 'GET', path);
    expect(member.status, JSON.stringify(member.json)).toBe(200);
  });
});

describe("an organization's member routes, declared by their extracted rules", () => {
  it('lets an admin add a member but not grant owner (org.own), and a member leave themself', async () => {
    const owner = await createTestUser({ verified: true });
    const admin = await createTestUser({ verified: true });
    const third = await createTestUser({ verified: true });
    const ownerToken = await userToken(owner.id);
    const adminToken = await userToken(admin.id);

    const created = await api(ownerToken, 'POST', '/api/orgs', {
      slug: `declared-${randomUUID().slice(0, 8)}`,
      name: 'Declared',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orgId = created.body.id as string;
    const mine = await api(ownerToken, 'GET', '/api/orgs');
    expect(JSON.stringify(mine.body)).toContain(orgId);

    const added = await api(ownerToken, 'POST', `/api/orgs/${orgId}/members`, {
      email: admin.email,
      role: 'admin',
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);

    const grant = await api(adminToken, 'POST', `/api/orgs/${orgId}/members`, {
      email: third.email,
      role: 'owner',
    });
    expect(grant.status, JSON.stringify(grant.body)).toBe(403);
    expect(JSON.stringify(grant.body)).toContain('org.own');

    const demote = await api(adminToken, 'PATCH', `/api/orgs/${orgId}/members/${owner.id}`, {
      role: 'member',
    });
    expect(demote.status, JSON.stringify(demote.body)).toBe(403);

    const left = await api(adminToken, 'DELETE', `/api/orgs/${orgId}/members/${admin.id}`);
    expect(left.status, JSON.stringify(left.body)).toBe(204);
  });
});

describe("a project's settings routes, declared org.admin resolved on its organization", () => {
  it('refuses archive to a project admin who is no org admin, and answers the org owner', async () => {
    const owner = await createTestUser({ verified: true });
    const projectAdmin = await createTestUser({ verified: true });
    const { id } = await createTestProject(owner.id);
    await addProjectMember(id, projectAdmin.id, 'admin');

    const refused = await api(
      await userToken(projectAdmin.id),
      'POST',
      `/api/projects/${id}/archive`,
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    const answered = await api(await userToken(owner.id), 'POST', `/api/projects/${id}/archive`);
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  });
});
