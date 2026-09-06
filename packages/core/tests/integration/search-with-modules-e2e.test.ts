/**
 * ISS-594 — `?withModules=1` on the issues search endpoint, against a real Postgres.
 *
 * This is the ONLY source web-v2's module column has: the search response serializes the raw
 * `issues` row and joins no labels, so nothing here can be proved against a mocked client — the
 * grouping, the `kind='module'` predicate and the primary-first order are all the database's.
 * `module-taxonomy-e2e.test.ts` owns the rest of the taxonomy; this file owns the read path the
 * list renders from.
 */

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

type Mods = {
  labelProjectRoutes: typeof import('../../src/labels/routes.js')['labelProjectRoutes'];
  issueProjectRoutes: typeof import('../../src/issues/routes.js')['issueProjectRoutes'];
  issueRoutes: typeof import('../../src/issues/routes.js')['issueRoutes'];
  searchRoutes: typeof import('../../src/issues/search.js')['searchRoutes'];
  signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];
  errorHandler: typeof import('../../src/middleware/error.js')['errorHandler'];
};

let harness: TestDatabase;
let mods: Mods;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let user: { id: string };
let project: { id: string };
let token: string;

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

  const [labelMod, issueMod, searchMod, jwtMod, errMod] = await Promise.all([
    import('../../src/labels/routes.js'),
    import('../../src/issues/routes.js'),
    import('../../src/issues/search.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
  ]);
  mods = {
    labelProjectRoutes: labelMod.labelProjectRoutes,
    issueProjectRoutes: issueMod.issueProjectRoutes,
    issueRoutes: issueMod.issueRoutes,
    searchRoutes: searchMod.searchRoutes,
    signUserToken: jwtMod.signUserToken,
    errorHandler: errMod.errorHandler,
  };

  app = new Hono();
  app.route('/api/projects', mods.labelProjectRoutes);
  app.route('/api/projects', mods.issueProjectRoutes);
  app.route('/api/projects', mods.searchRoutes);
  app.route('/api/issues', mods.issueRoutes);
  app.onError(mods.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  token = await mods.signUserToken(user.id);
});

const req = (path: string, init?: { method?: string; body?: unknown }) =>
  app.request(`/api${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

async function createModule(name: string) {
  const res = await req(`/projects/${project.id}/labels`, {
    method: 'POST',
    body: { name, kind: 'module' },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; name: string; color: string };
}

async function createLabel(body: Record<string, unknown>) {
  const res = await req(`/projects/${project.id}/labels`, { method: 'POST', body });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; name: string };
}

async function insertIssue(title: string): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${project.id}, ${Math.floor(Math.random() * 1_000_000)},
            ${title}, 'open', ${user.id})
  `);
  return id;
}

describe('ISS-594 · search ?withModules', () => {
  async function seedTwoIssues() {
    const mod = await createModule('pipeline');
    await createLabel({ name: 'bug', color: '#aabbcc' });
    const tagged = await insertIssue('tagged');
    const untagged = await insertIssue('untagged');
    await req(`/issues/${tagged}`, {
      method: 'PATCH',
      body: { labels: [{ labelId: 'pipeline' }] },
    });
    await req(`/issues/${untagged}`, { method: 'PATCH', body: { labels: ['bug'] } });
    return { mod, tagged, untagged };
  }

  const search = async (query: string) => {
    const res = await req(`/projects/${project.id}/issues/search?${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as { items: Array<Record<string, unknown>>; total: number };
  };

  // cm:guard `withModules` is the ONLY source for web-v2's module column (ISS-594) — the search response carries no labels otherwise, so a row missing the key renders an em dash for an issue that HAS a module, and nothing on either side reports the gap
  it('omits `modules` entirely unless the caller opts in', async () => {
    await seedTwoIssues();
    const body = (await search('')) as unknown as { items: Array<Record<string, unknown>> };
    for (const item of body.items) expect(item).not.toHaveProperty('modules');
  });

  it('answers the primary attribution under ?withModules=1', async () => {
    const { mod, tagged } = await seedTwoIssues();
    await req(`/issues/${tagged}`, {
      method: 'PATCH',
      body: { labels: [{ labelId: 'pipeline', isPrimary: true }] },
    });
    const body = (await search('withModules=1')) as unknown as {
      items: Array<{ id: string; modules: Array<{ labelId: string; isPrimary: boolean }> }>;
    };
    const row = body.items.find((i) => i.id === tagged);
    expect(row?.modules).toEqual([
      { labelId: mod.id, name: 'pipeline', color: expect.any(String), isPrimary: true },
    ]);
  });

  it('answers `[]` for an issue with no module, never a missing key', async () => {
    const { untagged } = await seedTwoIssues();
    const body = (await search('withModules=1')) as unknown as {
      items: Array<{ id: string; modules: unknown[] }>;
    };
    expect(body.items.find((i) => i.id === untagged)?.modules).toEqual([]);
  });

  it('leaves a plain label out of `modules`, though it sits on the same junction', async () => {
    const { untagged } = await seedTwoIssues();
    const body = (await search('withModules=1')) as unknown as {
      items: Array<{ id: string; modules: unknown[] }>;
    };
    expect(body.items.find((i) => i.id === untagged)?.modules).toEqual([]);
  });

  it('sorts the primary ahead of a secondary within one issue', async () => {
    const { tagged } = await seedTwoIssues();
    const second = await createModule('runner');
    await req(`/issues/${tagged}`, {
      method: 'PATCH',
      body: { labels: [{ labelId: second.id }, { labelId: 'pipeline', isPrimary: true }] },
    });
    const body = (await search('withModules=1')) as unknown as {
      items: Array<{ id: string; modules: Array<{ name: string }> }>;
    };
    expect(body.items.find((i) => i.id === tagged)?.modules.map((m) => m.name)).toEqual([
      'pipeline',
      'runner',
    ]);
  });
});
