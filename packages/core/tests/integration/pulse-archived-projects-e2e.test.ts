/**
 * ISS-1261 — the Overview reads `/api/me/pulse` and links every project it names to
 * `/projects/<slug>`, a page that resolves the slug against `GET /api/projects`, which leaves the
 * archived ones out. A pulse that named an archived project therefore linked to "Project not found".
 * Both reads are made here against one set of rows, so the property is that the pulse names no project
 * the list the page resolves from does not.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PulseResponse } from '../../src/me/pulse-types.js';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let signUserToken: (userId: string) => Promise<string>;
let seq = 0;

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

  const { mePulseRoutes } = await import('../../src/me/pulse-routes.js');
  const { projectRoutes } = await import('../../src/projects/routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  ({ signUserToken } = await import('../../src/auth/jwt.js'));

  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/me', mePulseRoutes);
  app.route('/api/projects', projectRoutes);
  app.onError(errorHandler);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

interface Seed {
  token: string;
  orgId: string;
  live: { id: string; slug: string };
  archived: { id: string; slug: string };
}

async function plantOpenIssue(projectId: string, createdBy: string): Promise<void> {
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${randomUUID()}, ${projectId}, ${seq}, ${`issue ${seq}`}, 'open', ${createdBy})`);
}

/** One org owner, one live project and one archived one, each with an open issue and no issue run. */
async function seed(): Promise<Seed> {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const org = await seedOrg(harness.db, user.id);
  const live = await createTestProject(harness.db, user.id, { orgId: org.id, slug: 'live-one' });
  const archived = await createTestProject(harness.db, user.id, {
    orgId: org.id,
    slug: 'archived-one',
  });
  for (const p of [live, archived]) {
    await createTestProjectMember(harness.db, { userId: user.id, projectId: p.id, role: 'admin' });
    await plantOpenIssue(p.id, user.id);
  }
  await harness.db.execute(sql`UPDATE projects SET archived_at = now() WHERE id = ${archived.id}`);
  return {
    token: await signUserToken(user.id),
    orgId: org.id,
    live: { id: live.id, slug: live.slug },
    archived: { id: archived.id, slug: archived.slug },
  };
}

async function get<T>(token: string, path: string): Promise<T> {
  const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

const namedSlugs = (p: PulseResponse): string[] => [
  ...p.work.perProject.map((r) => r.slug),
  ...p.work.neverRanProjects.shown.map((r) => r.slug),
  ...p.work.silentProjects.shown.map((r) => r.slug),
];

describe('the pulse names only projects the project page can open (ISS-1261)', () => {
  it('leaves an archived project out of every list that carries a project name, scoped or not', async () => {
    const s = await seed();
    for (const path of ['/api/me/pulse', `/api/me/pulse?orgId=${s.orgId}`]) {
      const pulse = await get<PulseResponse>(s.token, path);
      expect(pulse.work.perProject.map((r) => r.slug)).toEqual(['live-one']);
      expect(pulse.work.neverRanProjects.shown.map((r) => r.slug)).toEqual(['live-one']);
      expect(namedSlugs(pulse)).not.toContain(s.archived.slug);
    }
  });

  it('leaves an archived project out of the silent list, where the active one stands', async () => {
    const s = await seed();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      SELECT gen_random_uuid(), project_id, id, 'issue', 'completed', now() - interval '30 days'
      FROM issues`);
    for (const path of ['/api/me/pulse', `/api/me/pulse?orgId=${s.orgId}`]) {
      const pulse = await get<PulseResponse>(s.token, path);
      expect(pulse.work.silentProjects.total).toBe(1);
      expect(pulse.work.silentProjects.shown.map((r) => r.slug)).toEqual(['live-one']);
      expect(pulse.work.neverRanProjects.total).toBe(0);
    }
  });

  it('counts none of an archived project’s issues in the totals beside the rows', async () => {
    const s = await seed();
    const pulse = await get<PulseResponse>(s.token, '/api/me/pulse');
    expect(pulse.work.buckets.open).toBe(1);
  });

  it('names no slug the project list the page resolves from does not carry', async () => {
    const s = await seed();
    const pulse = await get<PulseResponse>(s.token, '/api/me/pulse');
    const list = await get<Array<{ slug: string }>>(s.token, '/api/projects');
    const openable = new Set(list.map((p) => p.slug));
    expect(namedSlugs(pulse).length).toBeGreaterThan(0);
    for (const slug of namedSlugs(pulse)) expect(openable.has(slug)).toBe(true);
  });

  it('answers a user whose every project is archived with the empty pulse, not an error', async () => {
    const s = await seed();
    await harness.db.execute(sql`UPDATE projects SET archived_at = now()`);
    const pulse = await get<PulseResponse>(s.token, '/api/me/pulse');
    expect(pulse.work.perProject).toEqual([]);
    expect(pulse.work.buckets.open).toBe(0);
  });

  it('names the project again once it is unarchived', async () => {
    const s = await seed();
    await harness.db.execute(
      sql`UPDATE projects SET archived_at = NULL WHERE id = ${s.archived.id}`,
    );
    const pulse = await get<PulseResponse>(s.token, '/api/me/pulse');
    expect(pulse.work.perProject.map((r) => r.slug).sort()).toEqual(['archived-one', 'live-one']);
  });
});
