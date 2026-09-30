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

let harness: TestDatabase;
let app: Hono<AppVars>;
let orgId: string;
let fenced: string;
let whole: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  const adminEmail = 'fence-admin@test.forge.local';
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  process.env.ADMIN_EMAILS = adminEmail;
  process.env.RATE_LIMIT_PAT_READ_MAX = '100000';
  process.env.RATE_LIMIT_PAT_WRITE_MAX = '100000';

  await truncateAll(harness.db);

  const user = await createTestUser(harness.db, { email: adminEmail });
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const org = await seedOrg(harness.db, user.id);
  orgId = org.id;
  const project = await createTestProject(harness.db, user.id, { orgId });
  await createTestProjectMember(harness.db, { projectId: project.id, userId: user.id });

  const { mintPat } = await import('../../src/auth/pat.js');
  const { PAT_GRANT_EPOCH } = await import('../../src/auth/pat-permissions.js');
  const base = { userId: user.id, permissions: ['*'], grantEpoch: PAT_GRANT_EPOCH };
  fenced = (await mintPat({ ...base, name: 'fenced', projectIds: [project.id] })).plaintext;
  whole = (await mintPat({ ...base, name: 'whole' })).plaintext;

  ({ app } = await import('../../src/index.js'));
});

afterAll(async () => {
  await harness.cleanup();
});

async function send(method: string, path: string, token: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const json = JSON.parse(text) as Record<string, unknown>;
  const error = json.error as Record<string, unknown> | undefined;
  return { status: res.status, code: error?.code ?? json.code, text };
}

describe('work that belongs to no one project refuses a token fenced to projects (ISS-28)', () => {
  it('refuses creating a project, naming the reach it would need', async () => {
    const res = await send('POST', '/api/projects', fenced, {
      slug: 'fenced-new',
      name: 'n',
      orgId,
    });
    expect(res.status).toBe(403);
    expect(res.code).toBe('PAT_ACCOUNT_ROUTE');
    expect(res.text).toContain('creating a project reaches beyond the projects');
  });

  it('lets a token carrying its whole reach create one', async () => {
    const res = await send('POST', '/api/projects', whole, { slug: 'whole-new', name: 'n', orgId });
    expect(res.status).toBe(201);
  });

  it('refuses the skill-activity audit that spans every project, and serves it unfenced', async () => {
    const refused = await send('GET', '/api/skill-activity/chain-integrity', fenced);
    expect(refused.status).toBe(403);
    expect(refused.code).toBe('PAT_ACCOUNT_ROUTE');
    const served = await send('GET', '/api/skill-activity/chain-integrity', whole);
    expect(served.status).toBe(200);
  });
});
