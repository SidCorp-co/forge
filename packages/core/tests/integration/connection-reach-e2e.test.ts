/**
 * Who reaches a connection, asked of the real doors against real Postgres (ISS-1216): the project's
 * org owner was answered `404 connection not found` for an App minted by another admin. Reach and
 * each door's own prerequisite are held apart — a plain member is refused the picker for being no
 * admin, and the other doors for having no reach.
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
  registerIntegrationsForTest,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  createConnection: typeof import('../../src/integrations/store.js').createConnection;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  createBinding: typeof import('../../src/integrations/store.js').createBinding;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  listGithubAppsReachableBy: typeof import('../../src/integrations/github/install-candidates.js').listGithubAppsReachableBy;
};

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let mods: Mods;
let app: Hono<AppVars>;

type Person = { id: string };
/** The individual who pressed Connect, so the App is minted `ownerType:'user'` against them. */
let clicker: Person;
/** Org owner of the project's org: a project admin by derivation, and a member of the org. */
let orgOwner: Person;
/** An explicit admin of the project who is not in its org at all. */
let boundAdmin: Person;
/** A plain member of the project: no admin, so no reach by the binding. */
let boundMember: Person;
/** An admin of ANOTHER project that the connection is not bound to. */
let otherAdmin: Person;
let stranger: Person;
let orgId: string;
let projectId: string;
let otherProjectId: string;

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
  process.env.PUBLIC_API_BASE_URL = 'http://localhost';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();

  const store = await import('../../src/integrations/store.js');
  mods = {
    createConnection: store.createConnection,
    createBinding: store.createBinding,
    signUserToken: (await import('../../src/auth/jwt.js')).signUserToken,
    listGithubAppsReachableBy: (await import('../../src/integrations/github/install-candidates.js'))
      .listGithubAppsReachableBy,
  };

  const { githubConnectRoutes } = await import('../../src/integrations/github/connect-routes.js');
  const { integrationsRoutes, integrationConnectionsRoutes } = await import(
    '../../src/integrations/routes.js'
  );
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<AppVars>();
  app.use('*', requestId());
  app.route('/api/integration-connections', integrationConnectionsRoutes);
  app.route('/api/projects', githubConnectRoutes);
  app.route('/api/projects', integrationsRoutes);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

async function verifiedUser(): Promise<Person> {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  return { id: user.id };
}

beforeEach(async () => {
  await truncateAll(harness.db);
  clicker = await verifiedUser();
  orgOwner = await verifiedUser();
  boundAdmin = await verifiedUser();
  boundMember = await verifiedUser();
  otherAdmin = await verifiedUser();
  stranger = await verifiedUser();

  orgId = (await seedOrg(harness.db, orgOwner.id)).id;
  projectId = (await createTestProject(harness.db, orgOwner.id, { orgId })).id;
  await createTestOrgMember(harness.db, { orgId, userId: clicker.id, role: 'member' });
  await createTestProjectMember(harness.db, { userId: clicker.id, projectId, role: 'admin' });
  await createTestProjectMember(harness.db, { userId: boundAdmin.id, projectId, role: 'admin' });
  await createTestProjectMember(harness.db, { userId: boundMember.id, projectId, role: 'member' });

  // Another org entirely, with a project the App is NOT bound to.
  const elsewhere = (await seedOrg(harness.db, otherAdmin.id)).id;
  otherProjectId = (await createTestProject(harness.db, otherAdmin.id, { orgId: elsewhere })).id;
});

const headers = async (userId: string) => ({
  authorization: `Bearer ${await mods.signUserToken(userId)}`,
  'content-type': 'application/json',
});

/** An App minted the old way: owned by the individual who pressed Connect, bound to one project. */
async function appOwnedByClicker(boundTo: string[] = [projectId]) {
  const connection = await mods.createConnection({
    ownerType: 'user',
    ownerId: clicker.id,
    provider: 'github',
    displayName: 'GitHub App forge-test',
    secrets: {},
  });
  for (const project of boundTo) {
    await mods.createBinding({
      connectionId: connection.id,
      projectId: project,
      provider: 'github',
      role: 'service',
      config: {},
    });
  }
  return connection;
}

type Body = {
  code?: string;
  message?: string;
  details?: unknown;
  items?: Array<{
    id: string;
    access: { reach: string; canManage: boolean };
    usage: { bindings: Array<{ projectId: string }> };
  }>;
};
const bodyOf = async (res: Response) => (await res.json()) as Body;

const directoryAs = async (userId: string) =>
  app.request('/api/integration-connections', { headers: await headers(userId) });
const bindingsAs = async (userId: string, connectionId: string) =>
  app.request(`/api/integration-connections/${connectionId}/bindings`, {
    headers: await headers(userId),
  });
const repositoriesAs = async (userId: string, connectionId: string, project = projectId) =>
  app.request(
    `/api/projects/${project}/integrations/github/repositories?connectionId=${connectionId}`,
    { headers: await headers(userId) },
  );

async function directoryIds(userId: string): Promise<string[]> {
  const res = await directoryAs(userId);
  expect(res.status).toBe(200);
  return ((await bodyOf(res)).items ?? []).map((i) => i.id).sort();
}

describe('the live refusal: an admin of the bound project who does not own the App', () => {
  it('finds the App in the directory, marked as reached through its binding and not theirs to change', async () => {
    const connection = await appOwnedByClicker();

    const res = await directoryAs(boundAdmin.id);
    const item = ((await bodyOf(res)).items ?? []).find((i) => i.id === connection.id);

    expect(res.status).toBe(200);
    expect(item?.access).toEqual({ reach: 'binding', canManage: false });
  });

  it('finds it as the org owner who is not the individual that pressed Connect, which is the screen that was measured', async () => {
    const connection = await appOwnedByClicker();

    expect(await directoryIds(orgOwner.id)).toEqual([connection.id]);
  });

  it('reaches the App through a binding that was switched off, which is where a repick starts', async () => {
    const connection = await appOwnedByClicker();
    await harness.db.execute(
      sql`UPDATE integration_bindings SET active = false WHERE connection_id = ${connection.id}`,
    );

    expect(await directoryIds(boundAdmin.id)).toEqual([connection.id]);
  });

  it('reaches any provider the same way, since the grant is about the binding and not about GitHub', async () => {
    const connection = await mods.createConnection({
      ownerType: 'user',
      ownerId: clicker.id,
      provider: 'coolify',
      displayName: 'Coolify',
      secrets: { apiToken: 't' },
      config: { baseUrl: 'https://coolify.example.com' },
    });
    await mods.createBinding({
      connectionId: connection.id,
      projectId,
      provider: 'coolify',
      role: 'service',
      config: {},
    });

    expect(await directoryIds(boundAdmin.id)).toEqual([connection.id]);
  });

  it("answers the connection's bindings route 200 instead of `connection not found`", async () => {
    const connection = await appOwnedByClicker();

    const res = await bindingsAs(boundAdmin.id, connection.id);

    expect(res.status).toBe(200);
    expect(((await bodyOf(res)) as { bindings: unknown[] }).bindings).toHaveLength(1);
  });

  it('shows such a reader only the bindings on projects they administer', async () => {
    const connection = await appOwnedByClicker([projectId, otherProjectId]);

    const viaBindings = (await bodyOf(
      await bindingsAs(boundAdmin.id, connection.id),
    )) as unknown as {
      bindings: Array<{ projectId: string }>;
    };
    const viaDirectory = ((await bodyOf(await directoryAs(boundAdmin.id))).items ?? []).find(
      (i) => i.id === connection.id,
    );

    expect(viaBindings.bindings.map((b) => b.projectId)).toEqual([projectId]);
    expect(viaDirectory?.usage.bindings.map((b) => b.projectId)).toEqual([projectId]);
  });

  it('still shows the owner every binding, because their reach is the credential and not one project', async () => {
    const connection = await appOwnedByClicker([projectId, otherProjectId]);

    const viaBindings = (await bodyOf(await bindingsAs(clicker.id, connection.id))) as unknown as {
      bindings: Array<{ projectId: string }>;
    };

    expect(viaBindings.bindings.map((b) => b.projectId).sort()).toEqual(
      [projectId, otherProjectId].sort(),
    );
  });
});

describe('who does not reach it', () => {
  it.each([
    ['a plain member of the bound project', () => boundMember],
    ['an admin of a project the App is not bound to', () => otherAdmin],
    ['a stranger', () => stranger],
  ])('%s sees nothing in the directory and is refused the bindings route', async (_name, who) => {
    const connection = await appOwnedByClicker();

    expect(await directoryIds(who().id)).toEqual([]);
    const res = await bindingsAs(who().id, connection.id);
    expect(res.status).toBe(404);
    expect((await bodyOf(res)).code).toBe('CONNECTION_NOT_REACHABLE');
  });

  it('answers a connection that does not exist the same way, so the refusal does not say which it was', async () => {
    const missing = randomUUID();
    const res = await bindingsAs(stranger.id, missing);
    const body = await bodyOf(res);

    expect(res.status).toBe(404);
    expect(body.code).toBe('CONNECTION_NOT_REACHABLE');
    expect(body.message).toContain(missing);
  });

  it('names the subject, who may see a connection, and the way round', async () => {
    const connection = await appOwnedByClicker();

    const body = await bodyOf(await bindingsAs(stranger.id, connection.id));

    expect(body.message).toContain(connection.id);
    expect(body.message).toMatch(/owner|organization/i);
    expect(body.message).toMatch(/admin of a project/i);
    expect(body.message).toMatch(/ask/i);
  });
});

describe('reading is not managing', () => {
  const patch = async (userId: string, connectionId: string) =>
    app.request(`/api/integration-connections/${connectionId}`, {
      method: 'PATCH',
      headers: await headers(userId),
      body: JSON.stringify({ displayName: 'renamed' }),
    });

  it('refuses a reader who is not the owner a rename, by name', async () => {
    const connection = await appOwnedByClicker();

    const res = await patch(boundAdmin.id, connection.id);
    const body = await bodyOf(res);

    expect(res.status).toBe(403);
    expect(body.code).toBe('CONNECTION_NOT_MANAGEABLE');
    expect(body.message).toContain(connection.id);
    expect(body.message).toMatch(/owner/i);
  });

  it('refuses the same reader a removal, and the connection is still active afterwards', async () => {
    const connection = await appOwnedByClicker();

    const res = await app.request(`/api/integration-connections/${connection.id}`, {
      method: 'DELETE',
      headers: await headers(boundAdmin.id),
    });

    expect(res.status).toBe(403);
    expect((await bodyOf(res)).code).toBe('CONNECTION_NOT_MANAGEABLE');
    const rows = (await harness.db.execute(
      sql`SELECT active FROM integration_connections WHERE id = ${connection.id}`,
    )) as unknown as Array<{ active: boolean }>;
    expect(rows[0]?.active).toBe(true);
  });

  it('refuses the same reader a health probe and a bind to another project', async () => {
    const connection = await appOwnedByClicker();

    const probe = await app.request(`/api/integration-connections/${connection.id}/test`, {
      method: 'POST',
      headers: await headers(boundAdmin.id),
    });
    const bind = await app.request(`/api/integration-connections/${connection.id}/bindings`, {
      method: 'POST',
      headers: await headers(boundAdmin.id),
      body: JSON.stringify({ projectId, role: 'service' }),
    });

    expect(probe.status).toBe(403);
    expect(bind.status).toBe(403);
    expect((await bodyOf(bind)).code).toBe('CONNECTION_NOT_MANAGEABLE');
  });

  it('still lets the individual who owns it change it', async () => {
    const connection = await appOwnedByClicker();

    expect((await patch(clicker.id, connection.id)).status).toBe(200);
  });

  it('refuses a caller who cannot reach it with the not-reachable refusal and not the manage one', async () => {
    const connection = await appOwnedByClicker();

    const res = await patch(stranger.id, connection.id);

    expect(res.status).toBe(404);
    expect((await bodyOf(res)).code).toBe('CONNECTION_NOT_REACHABLE');
  });

  describe('an org-owned connection', () => {
    let connectionId: string;
    beforeEach(async () => {
      const connection = await mods.createConnection({
        ownerType: 'org',
        ownerId: orgId,
        provider: 'github',
        displayName: 'GitHub App forge-test',
        secrets: {},
      });
      connectionId = connection.id;
    });

    it('is read by a plain org member, who is refused changing it by name', async () => {
      const [item] = ((await bodyOf(await directoryAs(clicker.id))).items ?? []).filter(
        (i) => i.id === connectionId,
      );
      expect(item?.access).toEqual({ reach: 'org', canManage: false });

      const res = await patch(clicker.id, connectionId);
      expect(res.status).toBe(403);
      const body = await bodyOf(res);
      expect(body.code).toBe('CONNECTION_NOT_MANAGEABLE');
      expect(body.message).toMatch(/organization/i);
    });

    it('is changed by an org owner', async () => {
      const [item] = ((await bodyOf(await directoryAs(orgOwner.id))).items ?? []).filter(
        (i) => i.id === connectionId,
      );
      expect(item?.access).toEqual({ reach: 'org', canManage: true });
      expect((await patch(orgOwner.id, connectionId)).status).toBe(200);
    });
  });
});

describe('every door reaches the same connections', () => {
  const people: Array<[string, boolean, () => Person]> = [
    ['the individual who owns it', true, () => clicker],
    ['the org owner', true, () => orgOwner],
    ['an admin of the bound project outside the org', true, () => boundAdmin],
    ['a plain member of the bound project', false, () => boundMember],
    ['an admin of an unrelated project', false, () => otherAdmin],
    ['a stranger', false, () => stranger],
  ];

  it.each(people)(
    '%s: reached = %s at the directory, the bindings route and the install probe',
    async (_name, reached, who) => {
      const connection = await appOwnedByClicker();

      const inDirectory = (await directoryIds(who().id)).includes(connection.id);
      const bindingsStatus = (await bindingsAs(who().id, connection.id)).status;
      const probed = (await mods.listGithubAppsReachableBy(who().id)).some(
        (c) => c.id === connection.id,
      );

      expect(inDirectory).toBe(reached);
      expect(bindingsStatus === 200).toBe(reached);
      expect(probed).toBe(reached);
    },
  );

  it.each(people.filter(([, reached]) => reached))(
    '%s: the picker, asked about the bound project, resolves it (reached = %s)',
    async (_name, _reached, who) => {
      const connection = await appOwnedByClicker();

      const res = await repositoriesAs(who().id, connection.id);

      // 400 is the App being reached and never converted; 404 would be the refusal.
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).details).toEqual({ connectionId: 'the App was never converted' });
    },
  );

  it('the picker refuses a member who is not an admin of the project before reach is asked', async () => {
    const connection = await appOwnedByClicker();

    expect((await repositoriesAs(boundMember.id, connection.id)).status).toBe(403);
  });

  it('the picker refuses an admin of an unrelated project for a connection that is not theirs', async () => {
    const connection = await appOwnedByClicker();

    const res = await repositoriesAs(otherAdmin.id, connection.id, otherProjectId);

    expect(res.status).toBe(404);
  });
});

describe("the project's github status card", () => {
  const githubCard = async (userId: string) => {
    const res = await app.request(`/api/projects/${projectId}/integrations/status`, {
      headers: await headers(userId),
    });
    const cards = ((await res.json()) as { cards: Array<{ key: string; status: string }> }).cards;
    return cards.find((c) => c.key === 'github');
  };

  beforeEach(async () => {
    await harness.db.execute(
      sql`UPDATE projects SET repo_path = '/tmp/forge-test-checkout' WHERE id = ${projectId}`,
    );
  });

  it('does not read Connected for a project that holds a checkout and no github binding', async () => {
    expect((await githubCard(orgOwner.id))?.status).toBe('not_configured');
  });

  it('reads the binding once there is one, and Disabled once it is switched off', async () => {
    const connection = await appOwnedByClicker();
    expect((await githubCard(orgOwner.id))?.status).toBe('unverified');

    await harness.db.execute(
      sql`UPDATE integration_connections SET last_health_status = 'ok', last_health_at = now() WHERE id = ${connection.id}`,
    );
    expect((await githubCard(orgOwner.id))?.status).toBe('connected');

    await harness.db.execute(
      sql`UPDATE integration_bindings SET active = false WHERE connection_id = ${connection.id}`,
    );
    expect((await githubCard(orgOwner.id))?.status).toBe('disabled');
  });
});
