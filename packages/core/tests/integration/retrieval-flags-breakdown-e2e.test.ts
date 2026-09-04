// Retrieval v3 phase 0 (ISS-904) against a real Postgres: the four app_config
// flags land with inert defaults through migration 0203 and round-trip on the
// REST surface under the admin rule, and the admin breakdown endpoint
// aggregates retrieval_analytics metadata per strategy over a window.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type RequestIdVars = import('../../src/middleware/request-id.js').RequestIdVars;

const ADMIN_EMAIL = 'admin@test.forge.local';

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;

  const [adminMod, appConfigMod, errMod, ridMod, jwtMod] = await Promise.all([
    import('../../src/admin/routes.js'),
    import('../../src/app-config/routes.js'),
    import('../../src/middleware/error.js'),
    import('../../src/middleware/request-id.js'),
    import('../../src/auth/jwt.js'),
  ]);
  signUserToken = jwtMod.signUserToken;
  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', ridMod.requestId());
  app.route('/api/admin', adminMod.adminRoutes);
  app.route('/api/app-config', appConfigMod.appConfigRoutes);
  app.onError(errMod.errorHandler);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function verifiedUser(email?: string) {
  const user = await createTestUser(harness.db, email ? { email } : {});
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  return user;
}

async function projectWith(role: 'admin' | 'member') {
  const user = await verifiedUser();
  const owner = await verifiedUser();
  const project = await createTestProject(harness.db, owner.id);
  await createTestProjectMember(harness.db, { userId: user.id, projectId: project.id, role });
  return { projectId: project.id, token: await signUserToken(user.id) };
}

const json = (token: string) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
});

async function insertAnalytics(
  projectId: string,
  metadata: Record<string, unknown>,
  hitCount: number,
  createdAt = 'now()',
) {
  await harness.db.execute(sql`
    INSERT INTO retrieval_analytics (id, project_id, query, hit_count, metadata, created_at)
    VALUES (${randomUUID()}, ${projectId}, 'q', ${hitCount}, ${JSON.stringify(metadata)}::jsonb,
            ${sql.raw(createdAt === 'now()' ? 'now()' : `'${createdAt}'::timestamptz`)})
  `);
}

describe('app_config retrieval flags (migration 0203)', () => {
  it('a row created without the flags carries off / flat / off / {}', async () => {
    const { projectId, token } = await projectWith('admin');
    const put = await app.request(`/api/app-config/${projectId}`, {
      method: 'PUT',
      headers: json(token),
      body: JSON.stringify({ retrievalTopK: 7 }),
    });
    expect(put.status).toBe(200);
    const row = (await put.json()) as Record<string, unknown>;
    expect(row.retrievalRerank).toBe(false);
    expect(row.memoryModel).toBe('flat');
    expect(row.retrievalExpandRelations).toBe(false);
    expect(row.memoryReindex).toEqual({});
  });

  it('an admin sets the two boolean flags without touching the other fields; GET reads them back', async () => {
    const { projectId, token } = await projectWith('admin');
    await app.request(`/api/app-config/${projectId}`, {
      method: 'PUT',
      headers: json(token),
      body: JSON.stringify({ retrievalTopK: 7, chatModel: 'keep-me' }),
    });
    const put = await app.request(`/api/app-config/${projectId}`, {
      method: 'PUT',
      headers: json(token),
      body: JSON.stringify({ retrievalRerank: true, retrievalExpandRelations: true }),
    });
    expect(put.status).toBe(200);
    const get = await app.request(`/api/app-config/${projectId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const row = (await get.json()) as Record<string, unknown>;
    expect(row.retrievalRerank).toBe(true);
    expect(row.memoryModel).toBe('flat');
    expect(row.retrievalExpandRelations).toBe(true);
    expect(row.retrievalTopK).toBe(7);
    expect(row.chatModel).toBe('keep-me');
  });

  it('a member is refused with 403 and the row is untouched', async () => {
    const { projectId, token } = await projectWith('member');
    const put = await app.request(`/api/app-config/${projectId}`, {
      method: 'PUT',
      headers: json(token),
      body: JSON.stringify({ retrievalRerank: true }),
    });
    expect(put.status).toBe(403);
    const rows = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM app_config WHERE project_id = ${projectId}`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('memoryModel is not writable here since ISS-906 (400); neither is memoryReindex (400)', async () => {
    const { projectId, token } = await projectWith('admin');
    const bad = await app.request(`/api/app-config/${projectId}`, {
      method: 'PUT',
      headers: json(token),
      body: JSON.stringify({ memoryModel: 'chunked' }),
    });
    expect(bad.status).toBe(400);
    const reindex = await app.request(`/api/app-config/${projectId}`, {
      method: 'PUT',
      headers: json(token),
      body: JSON.stringify({ memoryReindex: { state: 'running' } }),
    });
    expect(reindex.status).toBe(400);
  });
});

describe('GET /api/admin/retrieval/breakdown', () => {
  it('aggregates one row per strategy over the window with the hybrid sums', async () => {
    const admin = await verifiedUser(ADMIN_EMAIL);
    const project = await createTestProject(harness.db, admin.id);
    const otherProject = await createTestProject(harness.db, admin.id);
    const outsideWindow = '2026-01-01T00:00:00Z';
    const hybrid = { strategy: 'hybrid', requestedStrategy: 'hybrid' };
    await insertAnalytics(
      project.id,
      { ...hybrid, semanticHits: 5, keywordHits: 3, overlap: 1 },
      6,
    );
    await insertAnalytics(
      project.id,
      { ...hybrid, semanticHits: 2, keywordHits: 4, overlap: 2 },
      4,
    );
    await insertAnalytics(project.id, { strategy: 'semantic', requestedStrategy: 'semantic' }, 3);
    await insertAnalytics(
      project.id,
      { ...hybrid, semanticHits: 99, keywordHits: 99, overlap: 99 },
      1,
      outsideWindow,
    );
    await insertAnalytics(
      otherProject.id,
      { ...hybrid, semanticHits: 50, keywordHits: 50, overlap: 50 },
      1,
    );

    const token = await signUserToken(admin.id);
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const res = await app.request(
      `/api/admin/retrieval/breakdown?projectId=${project.id}&since=${encodeURIComponent(since)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      projectId: string;
      since: string;
      strategies: Array<Record<string, unknown>>;
    };
    expect(body.projectId).toBe(project.id);
    expect(body.strategies).toEqual([
      {
        strategy: 'hybrid',
        searches: 2,
        avgHitCount: 5,
        semanticHits: 7,
        keywordHits: 7,
        overlap: 3,
      },
      {
        strategy: 'semantic',
        searches: 1,
        avgHitCount: 3,
        semanticHits: 0,
        keywordHits: 0,
        overlap: 0,
      },
    ]);
  });

  it('a signed-in non-admin gets 403', async () => {
    const { projectId, token } = await projectWith('admin');
    const res = await app.request(`/api/admin/retrieval/breakdown?projectId=${projectId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('a missing projectId is 400', async () => {
    const admin = await verifiedUser(ADMIN_EMAIL);
    const res = await app.request('/api/admin/retrieval/breakdown', {
      headers: { authorization: `Bearer ${await signUserToken(admin.id)}` },
    });
    expect(res.status).toBe(400);
  });
});
