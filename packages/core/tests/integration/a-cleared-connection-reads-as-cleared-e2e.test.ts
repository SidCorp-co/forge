/**
 * ISS-1421 r36 — judge-145: right after a Clear, reading the cleared connection answered "This
 * connection is not one you can reach", which is false of the person who just cleared it. A Clear
 * leaves a record of what it deleted, and a read of that id by someone who could reach it is told it
 * was cleared; anyone else meets the sentence that says nothing of whether the id ever existed.
 * Through the real app against real Postgres.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };
type Store = typeof import('../../src/integrations/store.js');

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let store: Store;
let sign: (userId: string) => Promise<string>;
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
  ({ signUserToken: sign } = await import('../../src/auth/jwt.js'));
  ownerId = (await verifiedUser('cleared-owner@test.forge.local')).id;
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

async function verifiedUser(email: string) {
  const user = await createTestUser(harness.db, { email });
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  return user;
}

const callAs = async (userId: string, method: string, url: string, body?: unknown) => {
  const res = await app.request(url, {
    method,
    headers: {
      authorization: `Bearer ${await sign(userId)}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
};

/** A Sentry connection of the owner's, shared with `projectId`, removed and then cleared. */
async function clearedSentry(projectId: string): Promise<string> {
  const connection = await store.createConnection({
    ownerType: 'user',
    ownerId,
    provider: 'sentry',
    displayName: 'cleared sentry',
    config: { host: 'https://sentry.example' },
    secrets: { authToken: 'scratch-token' },
  });
  await store.createBinding({
    connectionId: connection.id,
    projectId,
    provider: 'sentry',
    role: 'service',
  });
  expect(
    (await callAs(ownerId, 'DELETE', `/api/integration-connections/${connection.id}`)).status,
  ).toBe(200);
  expect(
    (await callAs(ownerId, 'DELETE', `/api/integration-connections/${connection.id}`)).status,
  ).toBe(200);
  return connection.id;
}

const CLEARED =
  /^This Sentry connection was cleared from the list on \d{1,2} [A-Z][a-z]{2} \d{4}, which deleted it and took it off every project it was shared with\. It cannot be turned back on: connect a new one from the Integrations page\.$/;

describe('a connection read after its Clear (ISS-1421 r36)', () => {
  it('tells its owner it was cleared, on every read of it', async () => {
    const project = await createTestProject(harness.db, ownerId);
    const id = await clearedSentry(project.id);
    for (const [method, url, body] of [
      ['GET', `/api/integration-connections/${id}/bindings`, undefined],
      ['PATCH', `/api/integration-connections/${id}`, { displayName: 'renamed' }],
      ['POST', `/api/integration-connections/${id}/test`, undefined],
    ] as const) {
      const read = await callAs(ownerId, method, url, body);
      expect(read.status, `${method} ${url}: ${JSON.stringify(read.body)}`).toBe(410);
      expect(read.body.code).toBe('CONNECTION_CLEARED');
      expect(String(read.body.message)).toMatch(CLEARED);
      expect(String(read.body.message)).not.toContain('not one you can reach');
      expect(String(read.body.message)).not.toContain(id);
    }
  });

  it('tells a member of a project it was shared with the same', async () => {
    const project = await createTestProject(harness.db, ownerId);
    const member = await verifiedUser(
      `cleared-member-${randomUUID().slice(0, 6)}@test.forge.local`,
    );
    await createTestProjectMember(harness.db, {
      userId: member.id,
      projectId: project.id,
      role: 'member',
    });
    const id = await clearedSentry(project.id);
    const read = await callAs(member.id, 'GET', `/api/integration-connections/${id}/bindings`);
    expect(read.status).toBe(410);
    expect(String(read.body.message)).toMatch(CLEARED);
  });

  it('answers anyone who could not reach it as it answers an id that never was', async () => {
    const project = await createTestProject(harness.db, ownerId);
    const stranger = await verifiedUser(
      `cleared-stranger-${randomUUID().slice(0, 6)}@test.forge.local`,
    );
    const id = await clearedSentry(project.id);
    const cleared = await callAs(stranger.id, 'GET', `/api/integration-connections/${id}/bindings`);
    const never = await callAs(
      stranger.id,
      'GET',
      `/api/integration-connections/${randomUUID()}/bindings`,
    );
    expect(cleared.status).toBe(404);
    expect(cleared.body.code).toBe('CONNECTION_NOT_REACHABLE');
    expect(cleared.body.message).toBe(never.body.message);
  });

  it('keeps a delete of a cleared connection answering as already gone (criterion 269)', async () => {
    const project = await createTestProject(harness.db, ownerId);
    const id = await clearedSentry(project.id);
    const again = await callAs(ownerId, 'DELETE', `/api/integration-connections/${id}`);
    expect(again.status).toBe(404);
    expect(String(again.body.message)).toMatch(
      /^This connection is already gone, or is not one you can reach\./,
    );
  });

  it('leaves no record where a key saved since kept the connection', async () => {
    const project = await createTestProject(harness.db, ownerId);
    const connection = await store.createConnection({
      ownerType: 'user',
      ownerId,
      provider: 'sentry',
      displayName: 'kept sentry',
      config: { host: 'https://sentry.example' },
      secrets: { authToken: 'scratch-token' },
    });
    await store.createBinding({
      connectionId: connection.id,
      projectId: project.id,
      provider: 'sentry',
      role: 'service',
    });
    await callAs(ownerId, 'DELETE', `/api/integration-connections/${connection.id}`);
    // The Clear read the connection holding no key; one saved since is a key it did not read.
    expect(
      await (await import('../../src/integrations/connection-clears.js')).clearRemovedConnection({
        id: connection.id,
        secretsEnc: Buffer.from('another key'),
      }),
    ).toBe(false);
    const rows = await harness.db.execute(
      sql`SELECT 1 FROM integration_connection_clears WHERE connection_id = ${connection.id}`,
    );
    expect([...rows]).toHaveLength(0);
  });
});
