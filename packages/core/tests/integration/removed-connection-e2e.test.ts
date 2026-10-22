/**
 * ISS-1421 r22 — judge-91: a removed connection could still be shared and tested, writing a binding
 * that resolves nothing and a failed check on a connection that holds nothing; its GitHub repository
 * list said the App was never finished. Through the real app against real Postgres.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };
type Store = typeof import('../../src/integrations/store.js');
type Installation = typeof import('../../src/integrations/binding-installation.js');

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let store: Store;
let recordInstallation: Installation['recordInstallation'];
let token: string;
let ownerId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  // The connect start names the callback origin, and app.request reaches core at http://localhost.
  process.env.PUBLIC_API_BASE_URL = 'http://localhost';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
  process.env.NODE_ENV = 'test';
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
  store = await import('../../src/integrations/store.js');
  ({ recordInstallation } = await import('../../src/integrations/binding-installation.js'));
  const { registerAllIntegrations } = await import('../../src/integrations/register-all.js');
  registerAllIntegrations();
  const owner = await createTestUser(harness.db, { email: 'removed-connection@test.forge.local' });
  ownerId = owner.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`);
  const { signUserToken } = await import('../../src/auth/jwt.js');
  token = await signUserToken(owner.id);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

const call = async (method: string, url: string, body?: unknown) => {
  const res = await app.request(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
};

const rowOf = async (id: string) => {
  const rows = await harness.db.execute(
    sql`SELECT active, secrets_enc IS NULL AS wiped FROM integration_connections WHERE id = ${id}`,
  );
  return [...rows][0] as { active: boolean; wiped: boolean } | undefined;
};

async function rotatedSentry(owner: { type: 'user' | 'org'; id: string }) {
  return store.createConnection({
    ownerType: owner.type,
    ownerId: owner.id,
    provider: 'sentry',
    displayName: `sentry ${owner.id.slice(0, 6)}`,
    config: { host: 'https://sentry.example' },
    secrets: { authToken: 'scratch-new-token' },
  });
}

/** A connection removed while a project is bound to it, as judge-91 found them. */
async function removedSentryBoundTo(projectId: string) {
  const connection = await rotatedSentry({ type: 'user', id: ownerId });
  await store.createBinding({
    connectionId: connection.id,
    projectId,
    provider: 'sentry',
    role: 'service',
  });
  await call('DELETE', `/api/integration-connections/${connection.id}`);
  await store.updateConnection(connection.id, {
    lastHealthStatus: 'error',
    lastHealthDetail: 'checked before it was removed',
    lastHealthAt: new Date('2026-10-01T00:00:00Z'),
  });
  return connection;
}

const bindingCount = async (connectionId: string) =>
  [
    ...(await harness.db.execute(
      sql`SELECT 1 FROM integration_bindings WHERE connection_id = ${connectionId}`,
    )),
  ].length;

describe('a removed connection is neither shared nor tested (criteria 229 to 233)', () => {
  it('refuses a share by name and writes no binding', async () => {
    const bound = await createTestProject(harness.db, ownerId);
    const target = await createTestProject(harness.db, ownerId);
    const connection = await removedSentryBoundTo(bound.id);
    const shared = await call('POST', `/api/integration-connections/${connection.id}/bindings`, {
      projectId: target.id,
      role: 'service',
    });
    expect(shared.status, JSON.stringify(shared.body)).toBe(409);
    expect(shared.body.code).toBe('CONNECTION_REMOVED');
    expect(shared.body.message).toBe(
      'This connection was removed and holds no key, so it cannot be shared. Save a new key to turn it back on.',
    );
    expect(await bindingCount(connection.id)).toBe(1);
  });

  it("refuses a test from the connection's route and from the project's, the last check kept", async () => {
    const project = await createTestProject(harness.db, ownerId);
    const connection = await removedSentryBoundTo(project.id);
    const before = await harness.db.execute(
      sql`SELECT last_health_status, last_health_detail, last_health_at FROM integration_connections WHERE id = ${connection.id}`,
    );
    const tested = await call('POST', `/api/integration-connections/${connection.id}/test`);
    expect(tested.status, JSON.stringify(tested.body)).toBe(409);
    expect(tested.body.code).toBe('CONNECTION_REMOVED');
    expect(tested.body.message).toBe(
      'This connection was removed and holds no key, so it cannot be tested. Save a new key to turn it back on.',
    );
    const [binding] = await store.listBindingsForConnection(connection.id);
    const fromProject = await call(
      'POST',
      `/api/projects/${project.id}/integrations/${binding?.binding.id}/test`,
    );
    expect(fromProject.status, JSON.stringify(fromProject.body)).toBe(409);
    expect(fromProject.body.code).toBe('CONNECTION_REMOVED');
    const after = await harness.db.execute(
      sql`SELECT last_health_status, last_health_detail, last_health_at FROM integration_connections WHERE id = ${connection.id}`,
    );
    expect([...after]).toEqual([...before]);
  });

  // Consult F2: a secret saved beside the key leaves a secrets record but no key.
  it('reads a removed Rocket.Chat connection holding only its bot user as removed', async () => {
    const project = await createTestProject(harness.db, ownerId);
    const connection = await store.createConnection({
      ownerType: 'user',
      ownerId,
      provider: 'rocketchat',
      displayName: 'rc removed',
      config: { serverUrl: 'https://chat.example' },
      secrets: { authToken: 'scratch-rc-token', userId: 'scratch-bot' },
    });
    await call('DELETE', `/api/integration-connections/${connection.id}`);
    const saved = await call('PATCH', `/api/integration-connections/${connection.id}`, {
      secrets: { userId: 'scratch-bot-2' },
    });
    expect(saved.status).toBe(200);
    expect(await rowOf(connection.id)).toMatchObject({ active: false, wiped: false });
    expect(saved.body.connection).toMatchObject({ hasSecrets: false });
    const shared = await call('POST', `/api/integration-connections/${connection.id}/bindings`, {
      projectId: project.id,
      role: 'service',
    });
    expect(shared.body.code).toBe('CONNECTION_REMOVED');
    const tested = await call('POST', `/api/integration-connections/${connection.id}/test`);
    expect(tested.body.code).toBe('CONNECTION_REMOVED');
    const cleared = await call('DELETE', `/api/integration-connections/${connection.id}`);
    expect(cleared.status).toBe(200);
    expect(await rowOf(connection.id)).toBeUndefined();
  });
});

/** A project of its owner's personal organization, of which a person has one, whose App would be theirs. */
let personalOrgId: string | undefined;
const personalProject = async () => {
  personalOrgId ??= (await seedOrg(harness.db, ownerId, { isPersonal: true })).id;
  return createTestProject(harness.db, ownerId, { orgId: personalOrgId });
};

describe("a project's removed GitHub connection (criteria 224, 225)", () => {
  async function removedGithubOf(owner: { type: 'user' | 'org'; id: string }, projectId: string) {
    const connection = await store.createConnection({
      ownerType: owner.type,
      ownerId: owner.id,
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

  it('answers its repository list that it was removed, never that the App was never finished', async () => {
    const project = await personalProject();
    const connection = await removedGithubOf({ type: 'user', id: ownerId }, project.id);
    const listed = await call(
      'GET',
      `/api/projects/${project.id}/integrations/github/repositories?connectionId=${connection.id}`,
    );
    expect(listed.status, JSON.stringify(listed.body)).toBe(409);
    expect(listed.body.code).toBe('CONNECTION_REMOVED');
    expect(listed.body.message).toBe(
      "This GitHub connection was removed, so it holds no App. Install the GitHub App again from this project's Integrations tab, and it turns back on.",
    );
  });

  // judge-94 on 225 and 230: "from this project's tab" and "from a bound project's tab" were said where
  // the asking project is not bound, and where no project is (ISS-1421 r23).
  it('names the way back as it stands from where it is asked', async () => {
    const bound = await personalProject();
    const other = await personalProject();
    const connection = await removedGithubOf({ type: 'user', id: ownerId }, bound.id);
    const fromOther = await call(
      'GET',
      `/api/projects/${other.id}/integrations/github/repositories?connectionId=${connection.id}`,
    );
    expect(fromOther.body.code).toBe('CONNECTION_REMOVED');
    expect(fromOther.body.message).toBe(
      'This GitHub connection was removed, so it holds no App. Install the GitHub App again from a bound project whose App would belong to its owner, and it turns back on.',
    );
    const [binding] = await store.listBindingsForConnection(connection.id);
    const tested = await call(
      'POST',
      `/api/projects/${bound.id}/integrations/${binding?.binding.id}/test`,
    );
    expect(tested.body.message).toBe(
      "This connection was removed and holds no key, so it cannot be tested. Install the GitHub App again from this project's Integrations tab, and it turns back on.",
    );
    const shared = await call('POST', `/api/integration-connections/${connection.id}/bindings`, {
      projectId: other.id,
      role: 'service',
    });
    expect(shared.body.message).toBe(
      'This connection was removed and holds no key, so it cannot be shared. Install the GitHub App again from a bound project whose App would belong to its owner, and it turns back on.',
    );
  });

  it('says nothing turns back on a removed GitHub connection no project is bound to', async () => {
    const bound = await createTestProject(harness.db, ownerId);
    const other = await createTestProject(harness.db, ownerId);
    const connection = await removedGithubOf({ type: 'user', id: ownerId }, bound.id);
    await harness.db.execute(
      sql`DELETE FROM integration_bindings WHERE connection_id = ${connection.id}`,
    );
    const nothing =
      'No project is bound to it, so nothing can turn it back on. Clear it from the list on the Integrations page.';
    const listed = await call(
      'GET',
      `/api/projects/${other.id}/integrations/github/repositories?connectionId=${connection.id}`,
    );
    expect(listed.body.message).toBe(
      `This GitHub connection was removed, so it holds no App. ${nothing}`,
    );
    const shared = await call('POST', `/api/integration-connections/${connection.id}/bindings`, {
      projectId: other.id,
      role: 'service',
    });
    expect(shared.body.message).toBe(
      `This connection was removed and holds no key, so it cannot be shared. ${nothing}`,
    );
    const enabled = await call('PATCH', `/api/integration-connections/${connection.id}`, {
      active: true,
    });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(409);
    expect(enabled.body.message).toBe(
      `This connection holds no key, as removing it wiped its keys. ${nothing}`,
    );
  });

  // Whole-set review F1 (r23): the refusals before the connect promised the install the connect refuses.
  it('refuses to start an App the removed connection could not take, before GitHub is asked', async () => {
    const org = await seedOrg(harness.db, ownerId);
    const project = await createTestProject(harness.db, ownerId, { orgId: org.id });
    const connection = await removedGithubOf({ type: 'user', id: ownerId }, project.id);
    const listed = await call(
      'GET',
      `/api/projects/${project.id}/integrations/github/repositories?connectionId=${connection.id}`,
    );
    expect(listed.body.message).toBe(
      "This GitHub connection was removed, so it holds no App. An App installed from this project would belong to someone other than this connection's owner, so it cannot turn it back on. No project it is bound to would give a new App to its owner, so nothing can turn it back on. Clear it from the list on the Integrations page.",
    );
    const [binding] = await store.listBindingsForConnection(connection.id);
    const tested = await call(
      'POST',
      `/api/projects/${project.id}/integrations/${binding?.binding.id}/test`,
    );
    expect(String(tested.body.message)).not.toContain('turns back on');
    const started = await call('POST', `/api/projects/${project.id}/integrations/github/connect`);
    expect(started.status, JSON.stringify(started.body)).toBe(409);
    expect(started.body.code).toBe('REMOVED_CONNECTION_OTHER_OWNER');
    expect(started.body.message).toBe(OTHER_OWNER);

    // r24, judge-96: the refusal said to disconnect, and a disconnected project was refused the same
    // way, since the switched-off row still holds its one GitHub binding.
    const disconnected = await call(
      'DELETE',
      `/api/projects/${project.id}/integrations/${binding?.binding.id}`,
    );
    expect(disconnected.status, JSON.stringify(disconnected.body)).toBe(200);
    const again = await call('POST', `/api/projects/${project.id}/integrations/github/connect`);
    expect(again.body.code).toBe('REMOVED_CONNECTION_OTHER_OWNER');
    expect(again.body.message).toBe(OTHER_OWNER);
    expect(String(again.body.message)).not.toContain('Disconnect');

    // The act it names frees the project: the owner's Clear deletes the binding with the connection.
    const cleared = await call('DELETE', `/api/integration-connections/${connection.id}`);
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    const freed = await call('POST', `/api/projects/${project.id}/integrations/github/connect`);
    expect(freed.status, JSON.stringify(freed.body)).toBe(200);

    // r24, judge-96: deleting it again said only that it was not one the caller could reach.
    const gone = await call('DELETE', `/api/integration-connections/${connection.id}`);
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe('CONNECTION_NOT_REACHABLE');
    expect(gone.body.message).toBe(
      `Connection ${connection.id} is already gone, or is not one you can reach. Only its owner ` +
        "(for an organization's connection, an owner or admin of that organization) can delete it.",
    );
  });
});

const OTHER_OWNER =
  "This project's GitHub binding names a removed connection that an App created here would not " +
  "belong to, so the new App could not take its place. The connection's owner can clear it from " +
  'the list on the Integrations page, and then the App can be created here.';

// Whole-set review F1 and F2: what a request read can change before it writes.
describe('a write that races another (criteria 227, 238)', () => {
  it('keeps a removed connection a key was saved on between Clear reading it and deleting it', async () => {
    const project = await createTestProject(harness.db, ownerId);
    const connection = await removedSentryBoundTo(project.id);
    const read = await store.findConnectionById(connection.id);
    expect(read).toMatchObject({ active: false, secretsEnc: null });
    const saved = await call('PATCH', `/api/integration-connections/${connection.id}`, {
      secrets: { authToken: 'scratch-saved-meanwhile' },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await rowOf(connection.id)).toMatchObject({ active: false, wiped: false });

    expect(await store.clearRemovedConnection(read as NonNullable<typeof read>)).toBe(false);
    expect(await rowOf(connection.id)).toMatchObject({ wiped: false });
    expect(await bindingCount(connection.id)).toBe(1);
  });

  // r24 whole-set review F1: a Clear that loses to another answers as gone, however the race falls.
  it('answers the Clear that loses a race with the sentence a delete of a gone connection gets', async () => {
    const project = await createTestProject(harness.db, ownerId);
    const connection = await removedSentryBoundTo(project.id);
    const both = await Promise.all([
      call('DELETE', `/api/integration-connections/${connection.id}`),
      call('DELETE', `/api/integration-connections/${connection.id}`),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 404]);
    const lost = both.find((r) => r.status === 404);
    expect(lost?.body.message).toBe(
      `Connection ${connection.id} is already gone, or is not one you can reach. Only its owner ` +
        "(for an organization's connection, an owner or admin of that organization) can delete it.",
    );
  });

  it('fills a binding with one of two installations racing for it, the rest of its config kept', async () => {
    const project = await createTestProject(harness.db, ownerId);
    const connection = await rotatedSentry({ type: 'user', id: ownerId });
    const binding = await store.createBinding({
      connectionId: connection.id,
      projectId: project.id,
      provider: 'sentry',
      role: 'service',
      config: { repo: 'acme/app' },
    });
    const filled = await Promise.all([
      recordInstallation(binding.id, 111, true),
      recordInstallation(binding.id, 222, true),
    ]);
    expect(filled.filter(Boolean)).toHaveLength(1);
    const winner = filled[0] ? 111 : 222;
    const configOf = async () =>
      (await store.findBindingWithConnectionById(binding.id))?.binding.config;
    expect(await configOf()).toEqual({ repo: 'acme/app', installationId: winner });

    expect(await recordInstallation(binding.id, 333, true)).toBe(false);
    await store.updateBinding(binding.id, {
      config: { repo: 'acme/moved', installationId: winner },
    });
    expect(await recordInstallation(binding.id, 444, false)).toBe(true);
    expect(await configOf()).toEqual({ repo: 'acme/moved', installationId: 444 });
  });
});
