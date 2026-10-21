/**
 * ISS-1421 r20 — judge-82: deleting a connection only turned it off, its encrypted key kept, so
 * turning it on again brought the key back; and `GET /api/integration-connections?orgId=` listed
 * every org's connections. Through the real app against real Postgres.
 *
 * ISS-1421 r21 — judge-89: a removed GitHub connection stayed listed with nothing able to turn it on
 * or clear it, an org's removed connections outlived the org, and a key saved on a removed
 * connection still read the old key's failed check.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
} from '../helpers/index.js';

// The App a fresh install mints, as GitHub's manifest conversion would hand it back.
vi.mock('../../src/integrations/github/connect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/github/connect.js')>()),
  convertManifestCode: async () => ({
    appId: '4242',
    privateKey: 'scratch-new-app-pem',
    webhookSecret: 'scratch-new-hook-secret',
    slug: 'forge-reattached',
  }),
}));

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };
type Store = typeof import('../../src/integrations/store.js');

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let store: Store;
let token: string;
let ownerId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
  process.env.NODE_ENV = 'test';
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
  store = await import('../../src/integrations/store.js');
  const { registerAllIntegrations } = await import('../../src/integrations/register-all.js');
  registerAllIntegrations();
  const owner = await createTestUser(harness.db, { email: 'conn-delete@test.forge.local' });
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

/** A Sentry connection holding a key and a previous one, as a rotation leaves it. */
async function rotatedSentry(owner: { type: 'user' | 'org'; id: string }) {
  return store.createConnection({
    ownerType: owner.type,
    ownerId: owner.id,
    provider: 'sentry',
    displayName: `sentry ${owner.id.slice(0, 6)}`,
    config: { host: 'https://sentry.example' },
    secrets: {
      authToken: 'scratch-new-token',
      previousAuthToken: 'scratch-old-token',
      previousTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  });
}

const secretsOf = async (id: string) => {
  const rows = await harness.db.execute(
    sql`SELECT secrets_enc IS NULL AS wiped, active FROM integration_connections WHERE id = ${id}`,
  );
  return [...rows][0] as {
    wiped: boolean;
    active: boolean;
  };
};

describe('deleting a connection (criteria 210, 211)', () => {
  it('wipes every key stored on it and leaves it turned off', async () => {
    const connection = await rotatedSentry({ type: 'user', id: ownerId });
    expect(await secretsOf(connection.id)).toEqual({ wiped: false, active: true });
    const deleted = await call('DELETE', `/api/integration-connections/${connection.id}`);
    expect(deleted.status).toBe(200);
    expect(await secretsOf(connection.id)).toEqual({ wiped: true, active: false });
  });

  it('cannot be turned back on without a new key', async () => {
    const connection = await rotatedSentry({ type: 'user', id: ownerId });
    await call('DELETE', `/api/integration-connections/${connection.id}`);
    const on = await call('PATCH', `/api/integration-connections/${connection.id}`, {
      active: true,
    });
    expect(on.status).toBe(409);
    expect(on.body.code).toBe('CONNECTION_HAS_NO_KEY');
    expect(on.body.message).toBe(
      'This connection holds no key, as removing it wiped its keys. Save a new key to turn it back on.',
    );
    expect((await secretsOf(connection.id)).active).toBe(false);
  });

  // Eighth whole-set read: a deleted Rocket.Chat connection sent its bot user alone was turned on.
  it('is not turned on by a secret saved beside the key', async () => {
    const connection = await store.createConnection({
      ownerType: 'user',
      ownerId,
      provider: 'rocketchat',
      displayName: 'rc',
      config: { serverUrl: 'https://chat.example' },
      secrets: { authToken: 'scratch-rc-token', userId: 'scratch-bot' },
    });
    await call('DELETE', `/api/integration-connections/${connection.id}`);
    const on = await call('PATCH', `/api/integration-connections/${connection.id}`, {
      active: true,
      secrets: { userId: 'scratch-bot-2' },
    });
    expect(on.status, JSON.stringify(on.body)).toBe(409);
    expect(on.body.code).toBe('CONNECTION_HAS_NO_KEY');
    const saved = await call('PATCH', `/api/integration-connections/${connection.id}`, {
      secrets: { userId: 'scratch-bot-2' },
    });
    expect(saved.status).toBe(200);
    const after = await call('PATCH', `/api/integration-connections/${connection.id}`, {
      active: true,
    });
    expect(after.status).toBe(409);
  });

  it('turns back on with a new key, which is all it holds', async () => {
    const connection = await rotatedSentry({ type: 'user', id: ownerId });
    await call('DELETE', `/api/integration-connections/${connection.id}`);
    const on = await call('PATCH', `/api/integration-connections/${connection.id}`, {
      active: true,
      secrets: { authToken: 'scratch-fresh-token' },
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    const row = await store.findConnectionById(connection.id);
    const { decryptJson } = await import('../../src/integrations/vault.js');
    expect(decryptJson(row?.secretsEnc as Buffer)).toEqual({ authToken: 'scratch-fresh-token' });
  });
});

describe('listing connections by organization (criterion 208)', () => {
  it('lists only the connections the named organization owns', async () => {
    const orgA = await seedOrg(harness.db, ownerId);
    const orgB = await seedOrg(harness.db, ownerId);
    const a = await rotatedSentry({ type: 'org', id: orgA.id });
    const b = await rotatedSentry({ type: 'org', id: orgB.id });
    const listed = await call('GET', `/api/integration-connections?orgId=${orgA.id}`);
    expect(listed.status).toBe(200);
    const ids = (listed.body.items as { id: string }[]).map((i) => i.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
    const all = await call('GET', '/api/integration-connections');
    const every = (all.body.items as { id: string }[]).map((i) => i.id);
    expect(every).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('refuses an orgId that is not a uuid, naming orgId', async () => {
    const got = await call('GET', '/api/integration-connections?orgId=acme');
    expect(got.status).toBe(400);
    expect(String(got.body.message)).toMatch(/^The field orgId /);
  });
});

const rowOf = async (id: string) => {
  const rows = await harness.db.execute(
    sql`SELECT active, secrets_enc IS NULL AS wiped, last_health_status AS health
        FROM integration_connections WHERE id = ${id}`,
  );
  return [...rows][0] as { active: boolean; wiped: boolean; health: string | null } | undefined;
};

describe('a removed connection (criterion 216)', () => {
  it('is cleared from the list, its bindings with it, by a delete of the removed row', async () => {
    const connection = await rotatedSentry({ type: 'user', id: ownerId });
    const project = await createTestProject(harness.db, ownerId);
    await store.createBinding({
      connectionId: connection.id,
      projectId: project.id,
      provider: 'sentry',
      role: 'service',
    });
    await call('DELETE', `/api/integration-connections/${connection.id}`);
    expect(await rowOf(connection.id)).toMatchObject({ active: false, wiped: true });

    const cleared = await call('DELETE', `/api/integration-connections/${connection.id}`);
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(await rowOf(connection.id)).toBeUndefined();
    const bindings = await harness.db.execute(
      sql`SELECT 1 FROM integration_bindings WHERE connection_id = ${connection.id}`,
    );
    expect([...bindings]).toHaveLength(0);
    const listed = await call('GET', '/api/integration-connections');
    expect((listed.body.items as { id: string }[]).map((i) => i.id)).not.toContain(connection.id);
  });

  it('is only switched off and wiped by a first delete, even when it was already disabled', async () => {
    const connection = await rotatedSentry({ type: 'user', id: ownerId });
    await call('PATCH', `/api/integration-connections/${connection.id}`, { active: false });
    await call('DELETE', `/api/integration-connections/${connection.id}`);
    expect(await rowOf(connection.id)).toMatchObject({ active: false, wiped: true });
  });

  it('says for GitHub that installing the App again turns it back on, not a key', async () => {
    const connection = await store.createConnection({
      ownerType: 'user',
      ownerId,
      provider: 'github',
      displayName: 'GitHub App old',
      config: {},
      secrets: { appId: '1', privateKey: 'scratch-old-pem', webhookSecret: 'scratch-old-hook' },
    });
    await call('DELETE', `/api/integration-connections/${connection.id}`);
    const on = await call('PATCH', `/api/integration-connections/${connection.id}`, {
      active: true,
    });
    expect(on.status).toBe(409);
    expect(on.body.message).toBe(
      'This connection holds no key, as removing it wiped its keys. Install the GitHub App again from the Integrations tab of a project it is bound to, and it turns back on.',
    );
  });

  it('is turned back on by a fresh App install from a project still bound to it', async () => {
    const org = await seedOrg(harness.db, ownerId);
    const project = await createTestProject(harness.db, ownerId, { orgId: org.id });
    const old = await store.createConnection({
      ownerType: 'org',
      ownerId: org.id,
      provider: 'github',
      displayName: 'GitHub App old',
      config: {},
      secrets: { appId: '1', privateKey: 'scratch-old-pem', webhookSecret: 'scratch-old-hook' },
    });
    const binding = await store.createBinding({
      connectionId: old.id,
      projectId: project.id,
      provider: 'github',
      role: 'service',
      config: { installationId: 99, repository: 'acme/app' },
      integrationSecret: 'scratch-old-hook',
    });
    await store.updateConnection(old.id, { lastHealthStatus: 'error', lastHealthAt: new Date() });
    await call('DELETE', `/api/integration-connections/${old.id}`);

    const { signConnectState } = await import('../../src/integrations/github/connect.js');
    const state = signConnectState(process.env.JWT_SECRET as string, {
      projectId: project.id,
      userId: ownerId,
      orgId: org.id,
    });
    const res = await app.request(
      `/api/integrations/github/manifest-callback?code=scratch-code&state=${encodeURIComponent(state)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status, await res.clone().text()).toBe(302);

    expect(await rowOf(old.id)).toEqual({ active: true, wiped: false, health: null });
    const githubRows = await harness.db.execute(
      sql`SELECT id FROM integration_connections WHERE owner_id = ${org.id} AND provider = 'github'`,
    );
    expect([...githubRows].map((r) => (r as { id: string }).id)).toEqual([old.id]);
    const row = await store.findConnectionById(old.id);
    const { decryptJson } = await import('../../src/integrations/vault.js');
    expect(decryptJson(row?.secretsEnc as Buffer)).toMatchObject({ appId: '4242' });
    expect(row?.displayName).toBe('GitHub App forge-reattached');
    const [after] = [
      ...(await harness.db.execute(
        sql`SELECT active, config, integration_secret FROM integration_bindings WHERE id = ${binding.id}`,
      )),
    ] as { active: boolean; config: Record<string, unknown>; integration_secret: string }[];
    expect(after).toEqual({
      active: true,
      config: { repository: 'acme/app' },
      integration_secret: 'scratch-new-hook-secret',
    });
  });
});

describe('a key saved on a connection (criterion 220)', () => {
  it('clears the last check, so the connection reads not checked until it is tested', async () => {
    const connection = await rotatedSentry({ type: 'user', id: ownerId });
    await store.updateConnection(connection.id, {
      lastHealthStatus: 'error',
      lastHealthDetail: 'The key was refused.',
      lastHealthAt: new Date(),
    });
    await call('DELETE', `/api/integration-connections/${connection.id}`);
    const saved = await call('PATCH', `/api/integration-connections/${connection.id}`, {
      active: true,
      secrets: { authToken: 'scratch-fresh-token' },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.connection).toMatchObject({ lastHealthStatus: null, lastHealthAt: null });
    expect((await rowOf(connection.id))?.health).toBeNull();
  });

  it('keeps the last check where no key was sent', async () => {
    const connection = await rotatedSentry({ type: 'user', id: ownerId });
    await store.updateConnection(connection.id, {
      lastHealthStatus: 'ok',
      lastHealthAt: new Date(),
    });
    await call('PATCH', `/api/integration-connections/${connection.id}`, {
      displayName: 'renamed',
    });
    expect((await rowOf(connection.id))?.health).toBe('ok');
  });
});

describe('deleting an organization (criterion 219)', () => {
  it("deletes the connections it owns, removed ones included, and no one else's", async () => {
    const org = await seedOrg(harness.db, ownerId);
    const removed = await rotatedSentry({ type: 'org', id: org.id });
    const live = await rotatedSentry({ type: 'org', id: org.id });
    const mine = await rotatedSentry({ type: 'user', id: ownerId });
    await call('DELETE', `/api/integration-connections/${removed.id}`);

    const gone = await call('DELETE', `/api/orgs/${org.id}`);
    expect(gone.status, JSON.stringify(gone.body)).toBe(204);
    expect(await rowOf(removed.id)).toBeUndefined();
    expect(await rowOf(live.id)).toBeUndefined();
    expect(await rowOf(mine.id)).toMatchObject({ active: true });
  });
});
