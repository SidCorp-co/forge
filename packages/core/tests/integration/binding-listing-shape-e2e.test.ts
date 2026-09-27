/**
 * A binding listing answers under the name of the thing it lists (ISS-1191).
 *
 * Measured live on forge-dev 2026-09-25: `GET /api/projects/:id/integrations` answered top-level
 * keys `['items']` over 7 bindings, so `body.bindings` read `undefined` — the same observation a
 * project with no bindings at all produces. An operator who asked the object for its bindings
 * concluded three times in a row that there were none, and the configuration was correct
 * throughout. Against real Postgres, because the defect is the shape of a row set.
 *
 * `items` is kept beside `bindings`, holding the same rows: the `forge` CLI and the runner read it
 * and live in a repository this one does not change. Both routes are asserted to answer both.
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
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
};

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let mods: Mods;
let app: Hono<AppVars>;
let owner: { id: string };
let projectId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.PUBLIC_API_BASE_URL = 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();

  const store = await import('../../src/integrations/store.js');
  mods = {
    createConnection: store.createConnection,
    createBinding: store.createBinding,
    signUserToken: (await import('../../src/auth/jwt.js')).signUserToken,
  };

  const { integrationsRoutes, integrationConnectionsRoutes } = await import(
    '../../src/integrations/routes.js'
  );
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<AppVars>();
  app.use('*', requestId());
  app.route('/api/projects', integrationsRoutes);
  app.route('/api/integration-connections', integrationConnectionsRoutes);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  owner = { id: user.id };
  const orgId = (await seedOrg(harness.db, owner.id)).id;
  const project = await createTestProject(harness.db, owner.id, { orgId });
  projectId = project.id;
  await createTestProjectMember(harness.db, { userId: owner.id, projectId, role: 'admin' });
});

async function seedBinding(): Promise<string> {
  const connection = await mods.createConnection({
    ownerType: 'user',
    ownerId: owner.id,
    provider: 'sentry',
    displayName: 'Sentry',
    secrets: { authToken: 'tok' },
  });
  await mods.createBinding({
    connectionId: connection.id,
    projectId,
    provider: 'sentry',
    role: 'service',
    config: {},
  });
  return connection.id;
}

async function get(path: string) {
  const res = await app.request(path, {
    headers: { authorization: `Bearer ${await mods.signUserToken(owner.id)}` },
  });
  return (await res.json()) as { bindings?: unknown[]; items?: unknown[] };
}

describe('a binding listing answers under `bindings`', () => {
  it('answers the project listing under `bindings`, not only under `items`', async () => {
    await seedBinding();
    const body = await get(`/api/projects/${projectId}/integrations`);
    expect(body.bindings).toHaveLength(1);
  });

  it('answers the project listing under `items` too, with the same rows', async () => {
    await seedBinding();
    const body = await get(`/api/projects/${projectId}/integrations`);
    expect(body.items).toEqual(body.bindings);
  });

  it('answers `bindings` as an empty list where the project has none', async () => {
    const body = await get(`/api/projects/${projectId}/integrations`);
    expect(body.bindings).toEqual([]);
  });

  it("answers the connection's binding listing under `bindings`", async () => {
    const connectionId = await seedBinding();
    const body = await get(`/api/integration-connections/${connectionId}/bindings`);
    expect(body.bindings).toHaveLength(1);
  });

  it("answers the connection's binding listing under `items` too, with the same rows", async () => {
    const connectionId = await seedBinding();
    const body = await get(`/api/integration-connections/${connectionId}/bindings`);
    expect(body.items).toEqual(body.bindings);
  });
});
