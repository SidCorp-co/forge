/**
 * What a refusal at a connection's doors says, against real Postgres (ISS-1216): who owns the
 * connection, in the product's own words, and which project an installation is recorded on when
 * the App serves several. `connection-reach-e2e.test.ts` owns who reaches what.
 */

import { generateKeyPairSync } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };
type Person = { id: string };
type Body = {
  code?: string;
  message?: string;
  items?: Array<{
    id: string;
    access: { reach: string; canManage: boolean; ownerName: string | null };
  }>;
};

let harness: TestDatabase;
let app: Hono<AppVars>;
let createConnection: typeof import('../../src/integrations/store.js').createConnection;
let createBinding: typeof import('../../src/integrations/store.js').createBinding;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

/** The individual who pressed Connect: owns the App, and is a plain member of the org. */
let clicker: Person;
let orgOwner: Person;
/** An admin of the bound project who is not in its org. */
let boundAdmin: Person;
let stranger: Person;
let orgId: string;
let orgName: string;
let projectId: string;
/** A project of another org, which none of the above administers. */
let foreignProjectId: string;

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
  createConnection = store.createConnection;
  createBinding = store.createBinding;
  signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;

  const { githubCallbackRoutes } = await import('../../src/integrations/github/connect-routes.js');
  const { integrationConnectionsRoutes } = await import('../../src/integrations/routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<AppVars>();
  app.use('*', requestId());
  app.route('/api/integration-connections', integrationConnectionsRoutes);
  app.route('/api', githubCallbackRoutes);
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
  stranger = await verifiedUser();
  await harness.db.execute(
    sql`UPDATE users SET display_name = 'Dana Reyes' WHERE id = ${clicker.id}`,
  );

  const org = await seedOrg(harness.db, orgOwner.id, { name: 'Acme Platform' });
  orgId = org.id;
  orgName = org.name;
  projectId = (await createTestProject(harness.db, orgOwner.id, { orgId })).id;
  await createTestOrgMember(harness.db, { orgId, userId: clicker.id, role: 'member' });
  await createTestProjectMember(harness.db, { userId: boundAdmin.id, projectId, role: 'admin' });

  const elsewhere = await verifiedUser();
  const foreignOrg = (await seedOrg(harness.db, elsewhere.id)).id;
  foreignProjectId = (await createTestProject(harness.db, elsewhere.id, { orgId: foreignOrg })).id;
});

const headers = async (userId: string) => ({
  authorization: `Bearer ${await signUserToken(userId)}`,
  'content-type': 'application/json',
});
const bodyOf = async (res: Response) => (await res.json()) as Body;

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

/** An App owned by the individual who pressed Connect, bound to each project listed in order. */
async function appBoundTo(projects: string[], owner?: { type: 'org'; id: string }) {
  const connection = await createConnection({
    ownerType: owner?.type ?? 'user',
    ownerId: owner?.id ?? clicker.id,
    provider: 'github',
    displayName: 'GitHub App forge-test',
    secrets: { appId: '1', privateKey },
  });
  for (const project of projects) {
    await createBinding({
      connectionId: connection.id,
      projectId: project,
      provider: 'github',
      role: 'service',
      config: {},
    });
  }
  return connection;
}

describe('a refusal to change a connection names its owner', () => {
  const patch = async (userId: string, connectionId: string) =>
    app.request(`/api/integration-connections/${connectionId}`, {
      method: 'PATCH',
      headers: await headers(userId),
      body: JSON.stringify({ displayName: 'renamed' }),
    });

  it("names a person as the product shows them, not as 'another individual'", async () => {
    const connection = await appBoundTo([projectId]);

    const body = await bodyOf(await patch(boundAdmin.id, connection.id));

    expect(body.code).toBe('CONNECTION_NOT_MANAGEABLE');
    expect(body.message).toContain('owned by Dana Reyes');
    expect(body.message).toContain('Ask Dana Reyes');
    expect(body.message).not.toMatch(/another individual/i);
  });

  it('names a person who set no display name by their email', async () => {
    const connection = await appBoundTo([projectId]);
    await harness.db.execute(sql`UPDATE users SET display_name = NULL WHERE id = ${clicker.id}`);
    const rows = (await harness.db.execute(
      sql`SELECT email FROM users WHERE id = ${clicker.id}`,
    )) as unknown as Array<{ email: string }>;

    const body = await bodyOf(await patch(boundAdmin.id, connection.id));

    expect(body.message).toContain(`owned by ${rows[0]?.email}`);
  });

  it('names an organization by its name and never by its id', async () => {
    const connection = await appBoundTo([projectId], { type: 'org', id: orgId });

    const body = await bodyOf(await patch(clicker.id, connection.id));

    expect(body.message).toContain(`owned by the organization ${orgName}`);
    expect(body.message).toContain('only an owner or admin of that organization');
    expect(body.message).not.toContain(orgId);
  });

  it('hands the screen the same name on the directory item, so it never derives one', async () => {
    const person = await appBoundTo([projectId]);
    const org = await appBoundTo([], { type: 'org', id: orgId });

    const asAdmin = await bodyOf(
      await app.request('/api/integration-connections', { headers: await headers(boundAdmin.id) }),
    );
    const asMember = await bodyOf(
      await app.request('/api/integration-connections', { headers: await headers(clicker.id) }),
    );

    const ownerNameOf = (body: Body, id: string) => body.items?.find((i) => i.id === id)?.access;
    expect(ownerNameOf(asAdmin, person.id)).toEqual({
      reach: 'binding',
      canManage: false,
      ownerName: 'Dana Reyes',
    });
    expect(ownerNameOf(asMember, org.id)).toEqual({
      reach: 'org',
      canManage: false,
      ownerName: orgName,
    });
  });
});

describe('finishing a GitHub installation for an App the caller reaches by a binding', () => {
  const INSTALLATION = 4242;

  // GitHub accepting the App's JWT is the one thing stubbed: the door's own question is which of
  // the App's bindings the caller may record the installation on.
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
  });
  afterEach(() => vi.restoreAllMocks());

  const installedAs = async (userId: string) =>
    app.request(`/api/integrations/github/installed?installation_id=${INSTALLATION}`, {
      headers: await headers(userId),
      redirect: 'manual',
    });

  async function installationOn(project: string): Promise<unknown> {
    const rows = (await harness.db.execute(
      sql`SELECT config FROM integration_bindings WHERE project_id = ${project}`,
    )) as unknown as Array<{ config: { installationId?: number } }>;
    return rows[0]?.config.installationId;
  }

  it('records it on the project the caller administers when the App is bound to others too', async () => {
    // The newest binding is a project the caller does not administer: the shape measured at beta.
    await appBoundTo([projectId, foreignProjectId]);

    const res = await installedAs(boundAdmin.id);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain(`/projects/${projectId}/settings/integrations`);
    expect(await installationOn(projectId)).toBe(INSTALLATION);
    expect(await installationOn(foreignProjectId)).toBeUndefined();
  });

  it('still completes for an App bound to the one project the caller administers', async () => {
    await appBoundTo([projectId]);

    expect((await installedAs(boundAdmin.id)).status).toBe(302);
    expect(await installationOn(projectId)).toBe(INSTALLATION);
  });

  it('refuses by name a caller who reaches the App and administers none of its projects', async () => {
    await appBoundTo([foreignProjectId]);

    const res = await installedAs(clicker.id);
    const body = await bodyOf(res);

    expect(res.status).toBe(403);
    expect(body.code).toBe('INSTALL_NOT_COMPLETABLE');
    expect(body.message).toContain('GitHub App forge-test');
    expect(body.message).toMatch(/admin of a project it is bound to/);
    expect(await installationOn(foreignProjectId)).toBeUndefined();
  });

  it('answers a caller who does not reach the App as it always has, with no binding found', async () => {
    await appBoundTo([projectId]);

    expect((await installedAs(stranger.id)).status).toBe(404);
  });
});
