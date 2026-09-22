/**
 * A project's GitHub App, reached by an admin who is not the person who
 * pressed Connect — against real Postgres, because the defect is a row.
 *
 * Measured live at production 1d1d63492 (ISS-1115 criterion 7): the org's own
 * owner opened Integrations → GitHub → Change repository and
 * `GET /api/projects/:id/integrations/github/repositories` answered
 * `404 connection not found`. The App had been minted `ownerType:'user'`
 * against whoever clicked, and the route re-derived visibility from the
 * caller's personal principal after it had already proved project admin.
 *
 * 404 versus 400 is the whole discriminator here and it needs no network: a
 * connection the route cannot resolve is `connection not found`, and one it
 * resolves whose App was never converted is `the App was never converted`.
 * The second means the App was reached.
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

/** The individual who pressed Connect; the App is minted against them. */
let clicker: { id: string };
/** The org owner: a project admin by derivation, and the identity the live 404 was seen at. */
let orgOwner: { id: string };
let orgId: string;
let projectId: string;

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
  const { integrationsRoutes } = await import('../../src/integrations/routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<AppVars>();
  app.use('*', requestId());
  app.route('/api/projects', githubConnectRoutes);
  app.route('/api/projects', integrationsRoutes);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

async function verifiedUser(): Promise<{ id: string }> {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  return { id: user.id };
}

beforeEach(async () => {
  await truncateAll(harness.db);
  clicker = await verifiedUser();
  orgOwner = await verifiedUser();
  orgId = (await seedOrg(harness.db, orgOwner.id)).id;
  const project = await createTestProject(harness.db, orgOwner.id, { orgId });
  projectId = project.id;
  await createTestOrgMember(harness.db, { orgId, userId: clicker.id, role: 'member' });
  await createTestProjectMember(harness.db, { userId: clicker.id, projectId, role: 'admin' });
});

/** An App minted the old way, and never converted — so a reach shows as 400, not a GitHub call. */
async function appOwnedBy(userId: string, boundTo: string | null = projectId) {
  const connection = await mods.createConnection({
    ownerType: 'user',
    ownerId: userId,
    provider: 'github',
    displayName: 'GitHub App forge-test',
    secrets: {},
  });
  if (boundTo) {
    await mods.createBinding({
      connectionId: connection.id,
      projectId: boundTo,
      provider: 'github',
      role: 'service',
      config: {},
    });
  }
  return connection;
}

async function repositoriesAs(userId: string, connectionId: string, project = projectId) {
  return app.request(
    `/api/projects/${project}/integrations/github/repositories?connectionId=${connectionId}`,
    { headers: { authorization: `Bearer ${await mods.signUserToken(userId)}` } },
  );
}

describe("the repository picker's reach", () => {
  it('reaches an App another admin minted, which is the live 404 this issue was failed on', async () => {
    const connection = await appOwnedBy(clicker.id);

    const res = await repositoriesAs(orgOwner.id, connection.id);
    const body = (await res.json()) as { code: string; details?: unknown };

    expect(body.code).not.toBe('NOT_FOUND');
    expect(res.status).toBe(400);
    expect(body.details).toEqual({ connectionId: 'the App was never converted' });
  });

  it('reaches it through a binding that was switched off, which is where a repick starts', async () => {
    const connection = await appOwnedBy(clicker.id);
    await harness.db.execute(
      sql`UPDATE integration_bindings SET active = false WHERE connection_id = ${connection.id}`,
    );

    expect((await repositoriesAs(orgOwner.id, connection.id)).status).toBe(400);
  });

  it('still reaches an App the caller owns that no binding points at yet', async () => {
    const connection = await appOwnedBy(orgOwner.id, null);

    expect((await repositoriesAs(orgOwner.id, connection.id)).status).toBe(400);
  });

  it('refuses an App bound to a different project of the same org', async () => {
    const other = await createTestProject(harness.db, orgOwner.id, { orgId });
    const connection = await appOwnedBy(clicker.id, other.id);

    const res = await repositoriesAs(orgOwner.id, connection.id, projectId);

    expect(res.status).toBe(404);
    expect((await res.json()).message).toBe('connection not found');
  });

  it('refuses an App id that does not exist', async () => {
    expect((await repositoriesAs(orgOwner.id, randomUUID())).status).toBe(404);
  });

  it('refuses a project member who is not an admin, however the App is owned', async () => {
    const plain = await verifiedUser();
    await createTestProjectMember(harness.db, { userId: plain.id, projectId, role: 'member' });
    const connection = await appOwnedBy(clicker.id);

    expect((await repositoriesAs(plain.id, connection.id)).status).toBe(403);
  });

  it('refuses a stranger to the project', async () => {
    const stranger = await verifiedUser();
    const connection = await appOwnedBy(clicker.id);

    expect([403, 404]).toContain((await repositoriesAs(stranger.id, connection.id)).status);
  });
});

describe('who the App a Connect creates will belong to', () => {
  const connect = async (userId: string, query = '') =>
    app.request(`/api/projects/${projectId}/integrations/github/connect${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await mods.signUserToken(userId)}` },
    });

  function ownerInState(state: string) {
    const [payload] = state.split('.');
    return JSON.parse(Buffer.from(payload, 'base64url').toString()) as { orgId?: string };
  }

  it("names the project's own org, so the App is not keyed to one person again", async () => {
    const res = await connect(orgOwner.id);

    expect(res.status).toBe(200);
    expect(ownerInState(((await res.json()) as { state: string }).state).orgId).toBe(orgId);
  });

  it('refuses a project admin who is not an org admin, rather than minting a personal App', async () => {
    const res = await connect(clicker.id);
    const body = (await res.json()) as { code: string; message: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe('ORG_ADMIN_REQUIRED');
    expect(body.message).toContain(orgId);
    expect(body.message).toMatch(/org admin/i);
  });

  it("leaves a solo operator's App theirs, because a personal org owns nothing shared", async () => {
    const solo = await verifiedUser();
    const personal = await seedOrg(harness.db, solo.id, { isPersonal: true });
    const soloProject = await createTestProject(harness.db, solo.id, { orgId: personal.id });

    const res = await app.request(
      `/api/projects/${soloProject.id}/integrations/github/connect`,
      { method: 'POST', headers: { authorization: `Bearer ${await mods.signUserToken(solo.id)}` } },
    );

    expect(res.status).toBe(200);
    expect(ownerInState(((await res.json()) as { state: string }).state).orgId).toBeUndefined();
  });

  it("refuses an orgId that is not the project's own", async () => {
    const elsewhere = await seedOrg(harness.db, orgOwner.id);

    const res = await connect(orgOwner.id, `?orgId=${elsewhere.id}`);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ORG_MISMATCH');
  });
});

/**
 * The second door onto the same mechanism: finishing an installation GitHub
 * sent back without `state`, which identifies the App by probing the ones the
 * caller can reach. Asking only the caller's own principal left every admin
 * but the clicker with nothing to probe.
 */
describe('the Apps an install-completion may probe', () => {
  const idsOf = async (userId: string) =>
    (await mods.listGithubAppsReachableBy(userId)).map((c) => c.id).sort();

  it("includes an App another admin minted on a project the caller administers", async () => {
    const connection = await appOwnedBy(clicker.id);

    expect(await idsOf(orgOwner.id)).toEqual([connection.id]);
  });

  it('includes the caller\'s own App that no binding points at', async () => {
    const connection = await appOwnedBy(orgOwner.id, null);

    expect(await idsOf(orgOwner.id)).toEqual([connection.id]);
  });

  it('names an App reachable by both grants once', async () => {
    const connection = await appOwnedBy(orgOwner.id);

    expect(await idsOf(orgOwner.id)).toEqual([connection.id]);
  });

  it('leaves out an App on a project the caller is only a member of', async () => {
    const plain = await verifiedUser();
    await createTestProjectMember(harness.db, { userId: plain.id, projectId, role: 'member' });
    await appOwnedBy(clicker.id);

    expect(await idsOf(plain.id)).toEqual([]);
  });

  it('leaves out an App of a project the caller has no part in', async () => {
    const stranger = await verifiedUser();
    await appOwnedBy(clicker.id);

    expect(await idsOf(stranger.id)).toEqual([]);
  });

  it('reaches an App through a project the caller administers without being in its org', async () => {
    const elsewhere = (await seedOrg(harness.db, clicker.id)).id;
    const foreign = await createTestProject(harness.db, clicker.id, { orgId: elsewhere });
    const outsider = await verifiedUser();
    await createTestProjectMember(harness.db, {
      userId: outsider.id,
      projectId: foreign.id,
      role: 'admin',
    });
    const connection = await appOwnedBy(clicker.id, foreign.id);

    expect(await idsOf(outsider.id)).toEqual([connection.id]);
  });
});

/**
 * Disconnecting is reversible from the screen that offers it — ISS-1115's own
 * rule, and the half that only started biting once a project's App became
 * org-owned.
 *
 * DELETE on a binding asks for project admin and throws `binding.active` off.
 * The PATCH that throws it back on carried an org-admin bar, because `active`
 * was gated beside the connection-tier config and secrets although it writes
 * the binding. A project admin who is only an org member could therefore
 * disconnect and could not undo it.
 */
describe('putting back a binding this admin was allowed to disconnect', () => {
  let connectionId: string;
  let bindingId: string;

  /** The org-owned shape a Connect now mints, bound and carrying a repository. */
  beforeEach(async () => {
    const connection = await mods.createConnection({
      ownerType: 'org',
      ownerId: orgId,
      provider: 'github',
      displayName: 'GitHub App forge-test',
      secrets: { appId: '1', privateKey: 'pem' },
    });
    connectionId = connection.id;
    const binding = await mods.createBinding({
      connectionId,
      projectId,
      provider: 'github',
      role: 'service',
      config: { owner: 'SidCorp-co', repo: 'forge', installationId: 159473037 },
    });
    bindingId = binding.id;
  });

  const asUser = async (userId: string) => ({
    authorization: `Bearer ${await mods.signUserToken(userId)}`,
    'content-type': 'application/json',
  });

  const disconnect = async (userId: string) =>
    app.request(`/api/projects/${projectId}/integrations/${bindingId}`, {
      method: 'DELETE',
      headers: await asUser(userId),
    });

  const repick = async (userId: string, body: Record<string, unknown>) =>
    app.request(`/api/projects/${projectId}/integrations/${bindingId}`, {
      method: 'PATCH',
      headers: await asUser(userId),
      body: JSON.stringify(body),
    });

  const bindingActive = async () => {
    const rows = (await harness.db.execute(
      sql`SELECT active FROM integration_bindings WHERE id = ${bindingId}`,
    )) as unknown as Array<{ active: boolean }>;
    return rows[0]?.active ?? null;
  };

  it('lets the project admin who disconnected it switch it back on', async () => {
    expect((await disconnect(clicker.id)).status).toBe(200);
    expect(await bindingActive()).toBe(false);

    const res = await repick(clicker.id, {
      config: { owner: 'SidCorp-co', repo: 'forge', installationId: 159473037 },
      active: true,
    });

    expect(res.status).toBe(200);
    expect(await bindingActive()).toBe(true);
  });

  it('still refuses that admin the connection-tier write an org owns', async () => {
    const res = await repick(clicker.id, { secrets: { appId: '2', privateKey: 'other' } });

    expect(res.status).toBe(403);
    expect(await bindingActive()).toBe(true);
  });

  it('lets an org admin switch it back on too, and is not barred from the credential', async () => {
    await disconnect(orgOwner.id);

    const back = await repick(orgOwner.id, {
      config: { owner: 'SidCorp-co', repo: 'forge', installationId: 159473037 },
      active: true,
    });
    expect(back.status).toBe(200);
    expect(await bindingActive()).toBe(true);

    // Whatever the credential schema makes of it, the org tier is not the
    // thing refusing: that is the 403 the project admin gets above.
    const rotate = await repick(orgOwner.id, { secrets: { appId: '2', privateKey: 'other' } });
    expect(rotate.status).not.toBe(403);
  });

  it('refuses a project member who is not an admin either way', async () => {
    const plain = await verifiedUser();
    await createTestProjectMember(harness.db, { userId: plain.id, projectId, role: 'member' });

    expect((await disconnect(plain.id)).status).toBe(403);
    expect((await repick(plain.id, { active: false })).status).toBe(403);
  });
});
