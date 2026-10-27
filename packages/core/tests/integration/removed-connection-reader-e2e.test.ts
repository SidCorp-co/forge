/**
 * ISS-1421 r25 — judge-101: a switch-on carrying an empty `secrets` turned a binding on over a removed
 * connection (270), and every refusal about a removed connection offered Clear, a new key or an
 * install to a reader who would be refused it. r26 — judge-105: a member's keyless switch-on met the
 * org tier's bare 403 first, and a key saved from a project left the connection off. Through the real
 * app against real Postgres.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestOrgMember,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };
type Store = typeof import('../../src/integrations/store.js');

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let store: Store;
let signUserToken: (userId: string) => Promise<string>;
let token: string;
let ownerId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.PUBLIC_API_BASE_URL = 'http://localhost';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
  process.env.NODE_ENV = 'test';
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
  store = await import('../../src/integrations/store.js');
  const { registerAllIntegrations } = await import('../../src/integrations/register-all.js');
  registerAllIntegrations();
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  ownerId = (await verifiedUser('removed-reader-owner@test.forge.local')).id;
  token = await signUserToken(ownerId);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

async function verifiedUser(email: string) {
  const user = await createTestUser(harness.db, { email });
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  return user;
}

const callAs = async (bearer: string, method: string, url: string, body?: unknown) => {
  const res = await app.request(url, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
};
const call = (method: string, url: string, body?: unknown) => callAs(token, method, url, body);

/** A person who administers a project and neither owns its connection nor administers its owner. */
async function projectAdminOnly(projectId: string, orgId?: string) {
  const person = await verifiedUser(`admin-only-${projectId.slice(0, 8)}@test.forge.local`);
  await createTestProjectMember(harness.db, { userId: person.id, projectId, role: 'admin' });
  if (orgId) await createTestOrgMember(harness.db, { orgId, userId: person.id, role: 'member' });
  return signUserToken(person.id);
}

/** A Sentry connection of `owner`, bound to `projectId` and then removed by its owner. */
async function removedSentry(owner: { type: 'user' | 'org'; id: string }, projectId: string) {
  const connection = await store.createConnection({
    ownerType: owner.type,
    ownerId: owner.id,
    provider: 'sentry',
    displayName: `sentry ${owner.id.slice(0, 6)}`,
    config: { host: 'https://sentry.example' },
    secrets: { authToken: 'scratch-new-token' },
  });
  await store.createBinding({
    connectionId: connection.id,
    projectId,
    provider: 'sentry',
    role: 'service',
  });
  expect((await call('DELETE', `/api/integration-connections/${connection.id}`)).status).toBe(200);
  const [bound] = await store.listBindingsForConnection(connection.id);
  return { connection, bindingId: bound?.binding.id as string };
}

async function removedGithub(projectId: string) {
  const connection = await store.createConnection({
    ownerType: 'user',
    ownerId,
    provider: 'github',
    displayName: 'GitHub App gone',
    config: {},
    secrets: { appId: '1', privateKey: 'scratch-old-pem', webhookSecret: 'scratch-old-hook' },
  });
  await store.createBinding({
    connectionId: connection.id,
    projectId,
    provider: 'github',
    role: 'service',
    config: { installationId: 99 },
    integrationSecret: 'scratch-old-hook',
  });
  await call('DELETE', `/api/integration-connections/${connection.id}`);
  return connection;
}

describe('a switch-on over a removed connection that saves no key (criteria 270, 278, 279)', () => {
  it('refuses a switch-on carrying an empty secrets object, and writes nothing', async () => {
    const project = await createTestProject(harness.db, ownerId);
    const { bindingId } = await removedSentry({ type: 'user', id: ownerId }, project.id);
    await store.updateBinding(bindingId, { active: false });
    const before = await store.findBindingWithConnectionById(bindingId);
    const turned = await call('PATCH', `/api/projects/${project.id}/integrations/${bindingId}`, {
      active: true,
      secrets: {},
    });
    expect(turned.status, JSON.stringify(turned.body)).toBe(409);
    expect(turned.body.code).toBe('CONNECTION_REMOVED');
    expect(turned.body.message).toBe(
      'This connection was removed and holds no key, so it cannot be turned on for this project. Save a new key to turn it back on.',
    );
    const after = await store.findBindingWithConnectionById(bindingId);
    expect(after?.binding.active).toBe(false);
    expect(after?.binding.updatedAt).toEqual(before?.binding.updatedAt);
    expect(after?.connection.active).toBe(false);
  });
});

describe('a refusal about a removed connection, read by who asks (criteria 281 to 286)', () => {
  it('names who may save a key to a project admin who may not save one', async () => {
    const org = await seedOrg(harness.db, ownerId);
    const project = await createTestProject(harness.db, ownerId, { orgId: org.id });
    const { bindingId } = await removedSentry({ type: 'org', id: org.id }, project.id);
    const url = `/api/projects/${project.id}/integrations/${bindingId}`;
    const adminOnly = await projectAdminOnly(project.id, org.id);
    const who =
      'Only an owner or admin of the organization that owns it can save a new key to turn it back on.';

    const theirs = await callAs(adminOnly, 'PATCH', url, { active: true });
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(409);
    expect(theirs.body.message).toBe(
      `This connection was removed and holds no key, so it cannot be turned on for this project. ${who}`,
    );
    // An empty `secrets` saves nothing, so it asks no organization role and gets the same refusal.
    const empty = await callAs(adminOnly, 'PATCH', url, { active: true, secrets: {} });
    expect(empty.status, JSON.stringify(empty.body)).toBe(409);
    expect(empty.body.message).toBe(theirs.body.message);
    const tested = await callAs(adminOnly, 'POST', `${url}/test`);
    expect(tested.body.message).toBe(
      `This connection was removed and holds no key, so it cannot be tested. ${who}`,
    );
    const owners = await call('PATCH', url, { active: true });
    expect(owners.body.message).toBe(
      'This connection was removed and holds no key, so it cannot be turned on for this project. Save a new key to turn it back on.',
    );
  });

  it('offers a project admin who does not own the GitHub connection no Clear and no install', async () => {
    const personal = await seedOrg(harness.db, ownerId, { isPersonal: true });
    const project = await createTestProject(harness.db, ownerId, { orgId: personal.id });
    const connection = await removedGithub(project.id);
    const adminOnly = await projectAdminOnly(project.id);

    const listed = await callAs(
      adminOnly,
      'GET',
      `/api/projects/${project.id}/integrations/github/repositories?connectionId=${connection.id}`,
    );
    expect(listed.body.message).toBe(
      "This GitHub connection was removed, so it holds no App. Only its owner can install the GitHub App again from this project's Integrations tab, and it turns back on.",
    );
    const started = await callAs(
      adminOnly,
      'POST',
      `/api/projects/${project.id}/integrations/github/connect`,
    );
    expect(started.body.code).toBe('REMOVED_CONNECTION_OTHER_OWNER');
    expect(started.body.message).toBe(
      'This project reaches GitHub through a removed connection that an App created here would not ' +
        'belong to, so the new App could not take its place. Only its owner can clear it from the ' +
        'list on the Integrations page. Then the App can be created here.',
    );

    await harness.db.execute(
      sql`DELETE FROM integration_bindings WHERE connection_id = ${connection.id}`,
    );
    const other = await createTestProject(harness.db, ownerId);
    const otherAdmin = await projectAdminOnly(other.id);
    await store.createBinding({
      connectionId: connection.id,
      projectId: other.id,
      provider: 'github',
      role: 'service',
    });
    const [binding] = await store.listBindingsForConnection(connection.id);
    const tested = await callAs(
      otherAdmin,
      'POST',
      `/api/projects/${other.id}/integrations/${binding?.binding.id}/test`,
    );
    expect(tested.body.message).toBe(
      'This connection was removed and holds no key, so it cannot be tested. No project it is shared with would give a new App to its owner, so nothing can turn it back on. Only its owner can clear it from the list on the Integrations page.',
    );
    for (const said of [listed, started, tested]) {
      expect(String(said.body.message)).not.toMatch(/(^|\. )Clear it/);
    }
  });
});

const removedLine =
  'This connection was removed and holds no key, so it cannot be turned on for this project.';
const orgSavers =
  'Only an owner or admin of the organization that owns it can save a new key to turn it back on.';

describe('who a keyless switch-on and a key save answer (ISS-1421 r26, criteria 290, 291, 308, 309)', () => {
  it('answers a keyless switch-on 409 alike for the org member and the owner', async () => {
    const org = await seedOrg(harness.db, ownerId);
    const project = await createTestProject(harness.db, ownerId, { orgId: org.id });
    const { bindingId } = await removedSentry({ type: 'org', id: org.id }, project.id);
    const url = `/api/projects/${project.id}/integrations/${bindingId}`;
    const member = await projectAdminOnly(project.id, org.id);
    for (const secrets of [
      { authToken: '' },
      { authToken: null },
      { webhookSecret: 'scratch-x' },
    ]) {
      const theirs = await callAs(member, 'PATCH', url, { active: true, secrets });
      expect(theirs.status, JSON.stringify(theirs.body)).toBe(409);
      expect(theirs.body.code).toBe('CONNECTION_REMOVED');
      expect(theirs.body.message).toBe(`${removedLine} ${orgSavers}`);
      const owners = await call('PATCH', url, { active: true, secrets });
      expect(owners.status, JSON.stringify(owners.body)).toBe(409);
      expect(owners.body.code).toBe('CONNECTION_REMOVED');
    }
    const after = await store.findBindingWithConnectionById(bindingId);
    expect(after?.connection.secretsEnc).toBeNull();
  });

  it('refuses the org member a usable key by naming who may save it, and changes nothing', async () => {
    const org = await seedOrg(harness.db, ownerId);
    const project = await createTestProject(harness.db, ownerId, { orgId: org.id });
    const { bindingId } = await removedSentry({ type: 'org', id: org.id }, project.id);
    const url = `/api/projects/${project.id}/integrations/${bindingId}`;
    const member = await projectAdminOnly(project.id, org.id);
    const before = await store.findBindingWithConnectionById(bindingId);
    const saved = await callAs(member, 'PATCH', url, {
      active: true,
      secrets: { authToken: 'scratch-fresh-token' },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(403);
    expect(saved.body.message).toMatch(
      /only an owner or admin of the organization that owns it can change its key/,
    );
    const after = await store.findBindingWithConnectionById(bindingId);
    expect(after?.connection.secretsEnc).toBeNull();
    expect(after?.connection.active).toBe(false);
    expect(after?.binding.updatedAt).toEqual(before?.binding.updatedAt);
  });

  it('turns a removed connection back on with a key saved from the project, unchecked', async () => {
    const org = await seedOrg(harness.db, ownerId);
    const project = await createTestProject(harness.db, ownerId, { orgId: org.id });
    const { connection, bindingId } = await removedSentry({ type: 'org', id: org.id }, project.id);
    await harness.db.execute(
      sql`UPDATE integration_connections SET last_health_status = 'error', last_health_at = now() WHERE id = ${connection.id}`,
    );
    const saved = await call('PATCH', `/api/projects/${project.id}/integrations/${bindingId}`, {
      secrets: { authToken: 'scratch-fresh-token' },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const after = await store.findBindingWithConnectionById(bindingId);
    expect(after?.connection.active).toBe(true);
    expect(after?.connection.lastHealthStatus).toBeNull();
    expect(after?.binding.active).toBe(true);
  });

  it("lets a project admin bring a member's removed connection back in one save", async () => {
    const project = await createTestProject(harness.db, ownerId);
    const { bindingId } = await removedSentry({ type: 'user', id: ownerId }, project.id);
    const url = `/api/projects/${project.id}/integrations/${bindingId}`;
    const adminOnly = await projectAdminOnly(project.id);
    const told = await callAs(adminOnly, 'PATCH', url, { active: true });
    expect(told.body.message).toBe(`${removedLine} Save a new key to turn it back on.`);
    const saved = await callAs(adminOnly, 'PATCH', url, {
      active: true,
      secrets: { authToken: 'scratch-fresh-token' },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const after = await store.findBindingWithConnectionById(bindingId);
    expect(after?.connection.active).toBe(true);
    expect(after?.binding.active).toBe(true);
  });

  it("names a person's key savers to a project member who is not one", async () => {
    const project = await createTestProject(harness.db, ownerId);
    const { bindingId } = await removedSentry({ type: 'user', id: ownerId }, project.id);
    const person = await verifiedUser(`member-${project.id.slice(0, 8)}@test.forge.local`);
    await createTestProjectMember(harness.db, {
      userId: person.id,
      projectId: project.id,
      role: 'member',
    });
    const tested = await callAs(
      await signUserToken(person.id),
      'POST',
      `/api/projects/${project.id}/integrations/${bindingId}/test`,
    );
    expect(tested.body.message).toBe(
      'This connection was removed and holds no key, so it cannot be tested. Only its owner or an admin of a project it is shared with can save a new key to turn it back on.',
    );
  });
});

describe('the Coolify application list over a removed connection (ISS-1421 r26, criterion 292)', () => {
  it('says the connection was removed and who brings it back, rather than that a token is missing', async () => {
    const org = await seedOrg(harness.db, ownerId);
    const project = await createTestProject(harness.db, ownerId, { orgId: org.id });
    const connection = await store.createConnection({
      ownerType: 'org',
      ownerId: org.id,
      provider: 'coolify',
      displayName: 'coolify gone',
      config: { baseUrl: 'https://coolify.example' },
      secrets: { apiToken: 'scratch-coolify-token' },
    });
    await store.createBinding({
      connectionId: connection.id,
      projectId: project.id,
      provider: 'coolify',
      role: 'deploy',
      stages: ['live'],
    });
    expect((await call('DELETE', `/api/integration-connections/${connection.id}`)).status).toBe(
      200,
    );
    const [bound] = await store.listBindingsForConnection(connection.id);
    const member = await projectAdminOnly(project.id, org.id);
    const listed = await callAs(
      member,
      'POST',
      `/api/projects/${project.id}/integrations/coolify/applications`,
      { integrationId: bound?.binding.id },
    );
    expect(listed.status, JSON.stringify(listed.body)).toBe(409);
    expect(listed.body.code).toBe('CONNECTION_REMOVED');
    expect(listed.body.message).toBe(
      `This connection was removed and holds no key, so it cannot be asked for its applications. ${orgSavers}`,
    );
  });
});
