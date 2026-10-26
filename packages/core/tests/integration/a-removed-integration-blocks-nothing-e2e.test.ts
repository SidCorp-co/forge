/**
 * ISS-1421 r32 — judge-132: after a project's integration was removed (DELETE answers 200 and leaves
 * its binding switched off), connecting the same provider again answered 409 "An active service
 * binding for this provider and label already exists", which was untrue, and each refused create
 * left a nameless removed connection behind. `integration_bindings_service_uq` held switched-off
 * service bindings unique too; it now holds the switched-on ones. Through the real app against real
 * Postgres, every migration applied.
 */

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };
type Json = Record<string, unknown>;

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let signUserToken: (userId: string) => Promise<string>;
let ownerId: string;
let token: string;
let projectId: string;

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
  const { registerAllIntegrations } = await import('../../src/integrations/register-all.js');
  registerAllIntegrations();
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db, {
    email: `readd-${randomUUID().slice(0, 6)}@test.forge.local`,
  });
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`);
  ownerId = owner.id;
  token = await signUserToken(owner.id);
  projectId = (await createTestProject(harness.db, owner.id)).id;
});

async function call(method: string, url: string, body?: unknown) {
  const res = await app.request(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json };
}

const connectSentry = () =>
  call('POST', `/api/projects/${projectId}/integrations`, {
    provider: 'sentry',
    role: 'service',
    config: { host: 'https://sentry.example' },
    secrets: { authToken: 'scratch-token' },
  });

async function createdId(): Promise<string> {
  const made = await connectSentry();
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return (made.body.integration as { id: string }).id;
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await harness.db.execute(query)) as unknown as T[];
}

const connectionCount = async () =>
  (
    await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM integration_connections WHERE owner_id = ${ownerId}`,
    )
  )[0]?.n ?? 0;

describe('a project integration removed and connected again', () => {
  it('connects again after it was removed, the removed one kept switched off', async () => {
    const first = await createdId();
    expect((await call('DELETE', `/api/projects/${projectId}/integrations/${first}`)).status).toBe(
      200,
    );
    const second = await createdId();
    expect(second).not.toBe(first);
    const bindings = await rows<{ id: string; active: boolean }>(
      sql`SELECT id, active FROM integration_bindings WHERE project_id = ${projectId} ORDER BY created_at`,
    );
    expect(bindings).toEqual([
      { id: first, active: false },
      { id: second, active: true },
    ]);
  });

  it('refuses switching the removed one back on beside the new one, by name, and leaves both as they were', async () => {
    const first = await createdId();
    await call('DELETE', `/api/projects/${projectId}/integrations/${first}`);
    const second = await createdId();
    const on = await call('PATCH', `/api/projects/${projectId}/integrations/${first}`, {
      active: true,
    });
    expect([on.status, on.body.code, on.body.message]).toEqual([
      409,
      'ALREADY_EXISTS',
      'Another Sentry integration is switched on for this project, so this one cannot be switched on too. Disconnect that one from this project first.',
    ]);
    const bindings = await rows<{ id: string; active: boolean }>(
      sql`SELECT id, active FROM integration_bindings WHERE project_id = ${projectId} ORDER BY created_at`,
    );
    expect(bindings).toEqual([
      { id: first, active: false },
      { id: second, active: true },
    ]);
  });

  // Whole-set review F1: two removed bindings switched on at once, each with a new key. Whichever
  // loses is refused by name before its connection's key is touched, however the two interleave.
  it('switches on one of two removed bindings sent at once, and leaves the loser and its key as they were', async () => {
    const first = await createdId();
    await call('DELETE', `/api/projects/${projectId}/integrations/${first}`);
    const second = await createdId();
    await call('DELETE', `/api/projects/${projectId}/integrations/${second}`);
    const keys = async () =>
      rows<{ id: string; active: boolean; key: string }>(sql`
        SELECT b.id, b.active, encode(c.secrets_enc, 'hex') AS key
          FROM integration_bindings b JOIN integration_connections c ON c.id = b.connection_id
         WHERE b.project_id = ${projectId} ORDER BY b.created_at`);
    const before = await keys();
    const answers = await Promise.all(
      [first, second].map((id, i) =>
        call('PATCH', `/api/projects/${projectId}/integrations/${id}`, {
          active: true,
          secrets: { authToken: `scratch-new-${i}` },
        }),
      ),
    );
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    const lost = answers.findIndex((a) => a.status === 409);
    expect(answers[lost]?.body.message).toBe(
      'Another Sentry integration is switched on for this project, so this one cannot be switched on too. Disconnect that one from this project first.',
    );
    const after = await keys();
    expect(after.filter((b) => b.active).map((b) => b.id)).toEqual([[first, second][1 - lost]]);
    expect(after[lost]).toEqual(before[lost]);
  });

  it('refuses a second while one is switched on, and leaves no connection behind', async () => {
    await createdId();
    const before = await connectionCount();
    const again = await connectSentry();
    expect([again.status, again.body.message]).toEqual([
      409,
      'Sentry is already connected to this project. Disconnect it from this project before connecting another.',
    ]);
    expect(await connectionCount()).toBe(before);
  });

  // Whole-set review F2: a create refused after its connection was made deletes that connection.
  it('leaves no connection behind when the binding insert is refused after the connection was made', async () => {
    await harness.db.execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION refuse_binding_r32() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN RAISE EXCEPTION 'planted' USING ERRCODE = '23505'; END $f$`),
    );
    await harness.db.execute(
      sql.raw(`CREATE TRIGGER refuse_binding BEFORE INSERT ON integration_bindings
               FOR EACH ROW EXECUTE FUNCTION refuse_binding_r32()`),
    );
    try {
      const before = await connectionCount();
      const refused = await connectSentry();
      expect(refused.status).toBe(409);
      expect(await connectionCount()).toBe(before);
    } finally {
      await harness.db.execute(sql.raw('DROP TRIGGER refuse_binding ON integration_bindings'));
      await harness.db.execute(sql.raw('DROP FUNCTION refuse_binding_r32()'));
    }
  });

  it('names a binding still switched on over a removed connection, and leaves no connection behind', async () => {
    const first = await createdId();
    await harness.db.execute(sql`
      UPDATE integration_connections SET active = false, secrets_enc = NULL
       WHERE id = (SELECT connection_id FROM integration_bindings WHERE id = ${first})`);
    const before = await connectionCount();
    const again = await connectSentry();
    expect([again.status, again.body.message]).toEqual([
      409,
      'This project still has a Sentry integration switched on, over a connection that was removed. Disconnect that one from this project before connecting another.',
    ]);
    expect(await connectionCount()).toBe(before);
  });
});

// Whole-set review: a second GitHub App beside a GitHub binding switched on here would have no
// binding to land on, and its installation would be written onto the one already there.
describe('starting a GitHub App on a project', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const start = () => call('POST', `/api/projects/${projectId}/integrations/github/connect`);

  it('is refused by name where GitHub is connected to the project, and not once its connection was removed', async () => {
    const made = await call('POST', `/api/projects/${projectId}/integrations`, {
      provider: 'github',
      role: 'service',
      config: {},
      secrets: { appId: '900001', webhookSecret: 'scratch-webhook-r32', privateKey },
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const refused = await start();
    expect([refused.status, refused.body.code, refused.body.message]).toEqual([
      409,
      'ALREADY_EXISTS',
      'GitHub is already connected to this project. Disconnect it from this project before creating another GitHub App.',
    ]);
    const connectionId = (made.body.integration as { connectionId: string }).connectionId;
    await harness.db.execute(sql`
      UPDATE integration_connections SET active = false, secrets_enc = NULL WHERE id = ${connectionId}`);
    // Past this guard, the removed connection is judged by its own rule: here an App created on
    // this org project would not belong to the person who owns it.
    const started = await start();
    expect([started.status, started.body.code]).toEqual([409, 'REMOVED_CONNECTION_OTHER_OWNER']);
  });
});

// Whole-set review: two removed GitHub connections of one owner bound to the project, one binding
// switched off and the other on; the App flow takes the one switched on back.
describe('choosing which removed GitHub connection a new App takes', () => {
  it('takes the binding switched on, though an older switched-off one stands beside it', async () => {
    const store = await import('../../src/integrations/store.js');
    const removed = async (active: boolean) => {
      const connection = await store.createConnection({
        ownerType: 'user',
        ownerId,
        provider: 'github',
        displayName: `removed ${active}`,
        config: {},
        secrets: { appId: '1', privateKey: 'k', webhookSecret: 'scratch-hook' },
      });
      const binding = await store.createBinding({
        connectionId: connection.id,
        projectId,
        provider: 'github',
        role: 'service',
      });
      await store.updateBinding(binding.id, { active });
      await store.softDeleteConnection(connection.id);
      return binding.id;
    };
    await removed(false);
    const on = await removed(true);
    const chosen = await store.removedConnectionBoundTo(projectId, 'github', {
      ownerType: 'user',
      ownerId,
    });
    expect(chosen?.binding.id).toBe(on);
  });
});
