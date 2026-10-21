/**
 * ISS-1421 r20 — judge-82: deleting a connection only turned it off, its encrypted key kept, so
 * turning it on again brought the key back; and `GET /api/integration-connections?orgId=` listed
 * every org's connections. Through the real app against real Postgres.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestUser, seedOrg, setupTestDatabase, type TestDatabase } from '../helpers/index.js';

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
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
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
      'This connection holds no key, as deleting it wiped its keys. Save a new key to turn it back on.',
    );
    expect((await secretsOf(connection.id)).active).toBe(false);
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
