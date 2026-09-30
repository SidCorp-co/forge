import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

const EXAMPLES = new URL('../../src/project-config/fixtures/examples/', import.meta.url);
const example = (file: string) => JSON.parse(readFileSync(new URL(file, EXAMPLES), 'utf8'));

const CONNECTION = 'd1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a';
const SOURCE_BINDING = '7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const DEPLOY_BINDING = '8b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e';

let harness: TestDatabase;
let app: Hono<AppVars>;
let projectId: string;
let adminId: string;
let adminToken: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-abc';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 9).toString('base64');

  await truncateAll(harness.db);
  const admin = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  adminId = admin.id;
  const org = await seedOrg(harness.db, admin.id);
  const project = await createTestProject(harness.db, admin.id, { orgId: org.id });
  projectId = project.id;
  await createTestProjectMember(harness.db, { projectId, userId: admin.id, role: 'admin' });
  await harness.db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
    VALUES (${CONNECTION}, 'org', ${org.id}, 'shopify', true)
  `);

  const { signUserToken } = await import('../../src/auth/jwt.js');
  adminToken = await signUserToken(admin.id);
  ({ app } = await import('../../src/index.js'));
  (await import('../../src/integrations/register-all.js')).registerAllIntegrations();
});

afterAll(async () => {
  await harness.cleanup();
});

async function send(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: JSON.parse(await res.text()) };
}

const at = (suffix: string) => `/api/projects/${projectId}${suffix}`;

async function putBinding(file: string, baseRevision: number | null = null) {
  return send('PUT', at(`/bindings/${example(file).id}`), {
    baseRevision,
    document: example(file),
  });
}

const profile = (id: string) => ({
  $schema: 'https://forge.sidcorp.co/schemas/testing-profile-v1.json',
  version: 1,
  id,
  actors: {},
  services: {},
  limits: [],
});

describe('a storefront project with a source binding and a deploy binding', () => {
  it('writes the source binding through the binding API, with no stage', async () => {
    const res = await putBinding('store-source.binding.json');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ revision: 1, document: { role: 'source' } });
    const [row] = (await harness.db.execute(
      sql`SELECT role, stages FROM integration_bindings WHERE id = ${SOURCE_BINDING}`,
    )) as unknown as { role: string; stages: string[] }[];
    expect(row).toEqual({ role: 'source', stages: [] });
    await expect(
      harness.db.execute(sql`
        INSERT INTO integration_bindings (connection_id, project_id, provider, role, stages, active)
        VALUES (${CONNECTION}, ${projectId}, 'shopify', 'source', ARRAY['live'], true)
      `),
    ).rejects.toThrow();
  });

  it('refuses CONNECTION_PROVIDER_MISMATCH against the stored connection', async () => {
    const doc = example('store-deploy.binding.json');
    doc.target = { provider: 'coolify', applicationUuid: 'y8w4c4kss8ogo8gc44ow44kc' };
    const res = await send('PUT', at(`/bindings/${DEPLOY_BINDING}`), {
      baseRevision: null,
      document: doc,
    });
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe('CONNECTION_PROVIDER_MISMATCH');
  });

  it('refuses Forge deploying the storefront, then accepts it deployed outside Forge', async () => {
    expect((await putBinding('store-deploy.binding.json')).status).toBe(200);
    for (const id of ['theme-preview', 'storefront-smoke']) {
      const res = await send('PUT', at(`/testing-profiles/${id}`), {
        baseRevision: null,
        document: profile(id),
      });
      expect(res.status).toBe(200);
    }
    const doc = example('store.project.json');
    doc.project.id = projectId;
    const refused = await send('PUT', at('/config'), { baseRevision: null, document: doc });
    expect(refused.status).toBe(422);
    expect(refused.json.error.refusals).toEqual([
      expect.objectContaining({
        code: 'TRIGGER_UNSUPPORTED',
        path: '/environments/production/deployment/trigger',
      }),
    ]);
    doc.environments.production.deployment = { mode: 'external' };
    const res = await send('PUT', at('/config'), { baseRevision: null, document: doc });
    expect(res.json).toMatchObject({ declared: true, revision: 1, updatedBy: adminId });
    expect(res.status).toBe(200);
  });

  it('bumps a binding revision on any update, so a write based on the old one is STALE_BASE', async () => {
    await harness.db.execute(sql`
      UPDATE integration_bindings SET role = 'service' WHERE id = ${SOURCE_BINDING}
    `);
    const stale = await putBinding('store-source.binding.json', 1);
    expect(stale.status).toBe(422);
    expect(stale.json.error.code).toBe('STALE_BASE');

    const doc = example('store.project.json');
    doc.project.id = projectId;
    doc.environments.production.deployment = { mode: 'external' };
    const res = await send('PUT', at('/config'), { baseRevision: 1, document: doc });
    expect(res.status).toBe(422);
    expect(res.json.error.refusals).toEqual([
      expect.objectContaining({
        code: 'BINDING_ROLE_MISMATCH',
        path: '/source/storefront/binding',
      }),
    ]);
  });
});
