import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

const SECRET_VALUE = 'e2e-secret-value-that-must-never-leave-7c1d';

let harness: TestDatabase;
let app: Hono<AppVars>;
let projectId: string;
let slug: string;
let bindingId: string;
let adminToken: string;
let viewerToken: string;
let deviceToken: string;
let deviceId: string;

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
  process.env.RATE_LIMIT_PAT_READ_MAX = '100000';
  process.env.RATE_LIMIT_PAT_WRITE_MAX = '100000';

  await truncateAll(harness.db);

  const admin = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  const org = await seedOrg(harness.db, admin.id);
  const project = await createTestProject(harness.db, admin.id, { orgId: org.id });
  projectId = project.id;
  slug = project.slug;
  await createTestProjectMember(harness.db, { projectId, userId: admin.id, role: 'admin' });

  const viewer = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  await createTestProjectMember(harness.db, { projectId, userId: viewer.id, role: 'viewer' });

  const connection = randomUUID();
  bindingId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
    VALUES (${connection}, 'user', ${admin.id}, 'coolify', true)
  `);
  await harness.db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, stages, active)
    VALUES (${bindingId}, ${connection}, ${projectId}, 'coolify', 'deploy', ARRAY['live'], true)
  `);

  const device = await createTestDevice(harness.db, admin.id);
  deviceId = device.id;
  await bindTestRunner(harness.db, { projectId, deviceId });
  await harness.db.execute(sql`
    UPDATE runners SET repo_path = '/srv/checkout', branch = 'dev' WHERE device_id = ${deviceId}
  `);

  const { signUserToken } = await import('../../src/auth/jwt.js');
  adminToken = await signUserToken(admin.id);
  viewerToken = await signUserToken(viewer.id);
  const { mintPat } = await import('../../src/auth/pat.js');
  deviceToken = (await mintPat({ userId: admin.id, name: 'box', deviceId })).plaintext;

  ({ app } = await import('../../src/index.js'));
  (await import('../../src/integrations/register-all.js')).registerAllIntegrations();
});

afterAll(async () => {
  await harness.cleanup();
});

async function send(method: string, path: string, token: string | null, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}

const at = (suffix: string) => `/api/projects/${projectId}${suffix}`;

const projectDoc = (rollback = 'revert-and-redeploy') => ({
  $schema: 'https://forge.sidcorp.co/schemas/project-v1.json',
  version: 1,
  project: { id: projectId, slug, name: 'E2E' },
  source: {
    type: 'git',
    git: { repository: 'github.com/SidCorp-co/forge', defaultBranch: 'main', branches: ['main'] },
  },
  workspace: { isolation: 'worktree' },
  validation: { gate: { type: 'github-check', name: 'ci-passed' } },
  environments: {
    live: {
      tier: 'production',
      deploysFrom: 'main',
      deployment: { binding: bindingId, trigger: 'on-land' },
      testing: 'live',
    },
  },
  promotions: [],
  rollback: { strategy: rollback },
  execution: {
    plugin: { source: 'SidCorp-co/forge-plugin', ref: '73225dedb41b5da26b4ce73518086e26e81f91b8' },
  },
});

const profileDoc = (name: string) => ({
  $schema: 'https://forge.sidcorp.co/schemas/testing-profile-v1.json',
  version: 1,
  id: 'live',
  actors: { admin: { role: 'project-admin', credential: `secret://${slug}/${name}` } },
  services: {},
  limits: [],
});

describe('project config against a real database', () => {
  it('answers an unset document declared:false', async () => {
    const res = await send('GET', at('/config'), viewerToken);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ declared: false, revision: null, document: null });
  });

  it('refuses a testing profile whose secret is missing, then accepts it once the secret is written', async () => {
    const refused = await send('PUT', at('/testing-profiles/live'), adminToken, {
      baseRevision: null,
      document: profileDoc('admin-login'),
    });
    expect(refused.status).toBe(422);
    expect(refused.json.error.code).toBe('SECRET_NOT_FOUND');

    const secret = await send('PUT', at(`/secrets/${slug}/admin-login`), adminToken, {
      value: SECRET_VALUE,
    });
    expect(secret.status).toBe(200);
    const [row] = (await harness.db.execute(
      sql`SELECT value_enc FROM project_secrets WHERE project_id = ${projectId}`,
    )) as unknown as { value_enc: Buffer }[];
    expect(Buffer.from(row?.value_enc ?? []).toString('utf8')).not.toContain(SECRET_VALUE);

    const accepted = await send('PUT', at('/testing-profiles/live'), adminToken, {
      baseRevision: null,
      document: profileDoc('admin-login'),
    });
    expect(accepted.status).toBe(200);
  });

  it('writes, reads back, and keeps each revision write-once', async () => {
    const first = await send('PUT', at('/config'), adminToken, {
      baseRevision: null,
      document: projectDoc(),
    });
    expect(first.status).toBe(200);
    expect(first.json.revision).toBe(1);

    const stale = await send('PUT', at('/config'), adminToken, {
      baseRevision: null,
      document: projectDoc('none'),
    });
    expect(stale.status).toBe(422);
    expect(stale.json.error.code).toBe('STALE_BASE');

    const second = await send('PUT', at('/config'), adminToken, {
      baseRevision: 1,
      document: projectDoc('none'),
    });
    expect(second.json.revision).toBe(2);

    const read = await send('GET', at('/config'), viewerToken);
    expect(read.json.document).toEqual(projectDoc('none'));
    const revisions = await send('GET', at('/config/revisions'), viewerToken);
    expect(revisions.json.returned).toBe(2);

    await expect(
      harness.db.execute(
        sql`UPDATE project_config_revisions SET revision = 9 WHERE project_id = ${projectId}`,
      ),
    ).rejects.toThrow();
  });

  it('refuses a viewer write and writes nothing', async () => {
    const res = await send('PUT', at('/config'), viewerToken, {
      baseRevision: 2,
      document: projectDoc(),
    });
    expect(res.status).toBe(403);
    expect((await send('GET', at('/config'), viewerToken)).json.revision).toBe(2);
  });

  it('gives a device its own checkout in the effective config, and never a secret value', async () => {
    const res = await send('GET', at('/config/effective'), deviceToken);
    expect(res.status).toBe(200);
    expect(res.json.device).toBe(deviceId);
    expect(res.json.values['/checkout']).toEqual({
      from: 'device-binding',
      value: { deviceId, repoPath: '/srv/checkout', branch: 'dev' },
    });
    expect(res.json.values[`/bindings/${bindingId}`].from).toBe('binding');
    expect(res.json.values['/testing/live'].from).toBe('testing-profile');
    expect(res.text).not.toContain(SECRET_VALUE);

    const names = await send('GET', at('/secrets'), viewerToken);
    expect(names.text).not.toContain(SECRET_VALUE);
    expect(names.json.secrets[0].ref).toBe(`secret://${slug}/admin-login`);
  });

  it('serves the schemas with no credential through the mounted app', async () => {
    const res = await send('GET', '/api/schemas/project-v1.json', null);
    expect(res.status).toBe(200);
    expect(res.json.$id).toBe('https://forge.sidcorp.co/schemas/project-v1.json');
  });
});
