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

async function insertBinding(id: string, role: string, stages: string) {
  await harness.db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, stages, active)
    VALUES (${id}, ${CONNECTION}, ${projectId}, 'shopify', ${role}, ${stages}::text[], true)
  `);
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
  it('holds a source binding with no stage, and refuses one that names a stage', async () => {
    await insertBinding(SOURCE_BINDING, 'source', '{}');
    await expect(
      harness.db.execute(sql`
        INSERT INTO integration_bindings (connection_id, project_id, provider, role, stages, active)
        VALUES (${CONNECTION}, ${projectId}, 'shopify', 'source', ARRAY['live'], true)
      `),
    ).rejects.toThrow();
  });

  it('accepts the store example end to end', async () => {
    await insertBinding(DEPLOY_BINDING, 'deploy', '{live}');
    for (const id of ['theme-preview', 'storefront-smoke']) {
      const res = await send('PUT', at(`/testing-profiles/${id}`), {
        baseRevision: null,
        document: profile(id),
      });
      expect(res.status).toBe(200);
    }
    const doc = example('store.project.json');
    doc.project.id = projectId;
    const res = await send('PUT', at('/config'), { baseRevision: null, document: doc });
    expect(res.json).toMatchObject({ declared: true, revision: 1 });
    expect(res.status).toBe(200);
    expect(adminId).toBe(res.json.updatedBy);
  });

  it('refuses the example once its source binding is a service binding', async () => {
    await harness.db.execute(sql`
      UPDATE integration_bindings SET role = 'service' WHERE id = ${SOURCE_BINDING}
    `);
    const doc = example('store.project.json');
    doc.project.id = projectId;
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
