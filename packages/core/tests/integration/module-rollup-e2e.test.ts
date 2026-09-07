/**
 * ISS-949 — the backlog read by module, against a real Postgres.
 *
 * Every rule this issue states is a rule about rows the aggregation has to find or exclude: the
 * `kind='module'` narrowing, the primary/secondary split the partial unique index enforces, the
 * parent rollup, the zero-issue module and the unattributed bucket. A mocked db client returns
 * whatever the test told it to, so none of these can go red under one — they need the join.
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

type Counts = { total: number; open: number; closed: number; recentlyActive: number };
type Attribution = { primary: Counts; secondary: Counts };
type Row = {
  id: string;
  name: string;
  depth: number;
  own: Attribution;
  inherited: Attribution;
  rollup: Attribution;
};
type Rollup = {
  activeWithinDays: number;
  generatedAt: string;
  modules: Row[];
  unassigned: Counts;
};

type Mods = {
  labelProjectRoutes: typeof import('../../src/labels/routes.js')['labelProjectRoutes'];
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

  const [labelMod, jwtMod, errMod] = await Promise.all([
    import('../../src/labels/routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
  ]);
  mods = {
    labelProjectRoutes: labelMod.labelProjectRoutes,
    signUserToken: jwtMod.signUserToken,
    errorHandler: errMod.errorHandler,
  };

  app = new Hono();
  app.route('/api/projects', mods.labelProjectRoutes);
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

const req = (path: string, tok = token) =>
  app.request(`/api${path}`, {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
  });

async function rollup(query = ''): Promise<Rollup> {
  const res = await req(`/projects/${project.id}/modules/rollup${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Rollup;
}

const moduleNamed = (r: Rollup, name: string): Row => {
  const row = r.modules.find((m) => m.name === name);
  if (!row) throw new Error(`no module named ${name} in the rollup`);
  return row;
};

async function createModule(name: string, parentId?: string): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO labels (id, project_id, name, color, kind, slug, parent_id)
    VALUES (${id}, ${project.id}, ${name}, '#1f6f4a', 'module', ${name.toLowerCase()},
            ${parentId ?? null})
  `);
  return id;
}

async function createPlainLabel(name: string): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO labels (id, project_id, name, color) VALUES (${id}, ${project.id}, ${name}, '#aabbcc')
  `);
  return id;
}

async function insertIssue(status = 'open', updatedDaysAgo = 0): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, updated_at)
    VALUES (${id}, ${project.id}, ${Math.floor(Math.random() * 1_000_000)}, 'Issue', ${status},
            ${user.id}, now() - make_interval(days => ${updatedDaysAgo}))
  `);
  return id;
}

async function attach(issueId: string, labelId: string, isPrimary = false): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO issue_labels (issue_id, label_id, is_primary)
    VALUES (${issueId}, ${labelId}, ${isPrimary})
  `);
}

describe('ISS-949 · the attribution split', () => {
  it('counts a primary attribution in primary and not in secondary', async () => {
    const alpha = await createModule('alpha');
    await attach(await insertIssue(), alpha, true);

    const row = moduleNamed(await rollup(), 'alpha');
    expect(row.own.primary.total).toBe(1);
    expect(row.own.secondary.total).toBe(0);
  });

  it('counts a secondary attribution in secondary and not in primary', async () => {
    const beta = await createModule('beta');
    await attach(await insertIssue(), beta, false);

    const row = moduleNamed(await rollup(), 'beta');
    expect(row.own.secondary.total).toBe(1);
    expect(row.own.primary.total).toBe(0);
  });

  it('counts one issue in its primary module and in each of its secondaries', async () => {
    const alpha = await createModule('alpha');
    const beta = await createModule('beta');
    const gamma = await createModule('gamma');
    const issueId = await insertIssue();
    await attach(issueId, alpha, true);
    await attach(issueId, beta);
    await attach(issueId, gamma);

    const r = await rollup();
    expect(moduleNamed(r, 'alpha').own.primary.total).toBe(1);
    expect(moduleNamed(r, 'beta').own.secondary.total).toBe(1);
    expect(moduleNamed(r, 'gamma').own.secondary.total).toBe(1);
  });
});

describe('ISS-949 · what the aggregation reads', () => {
  it('reads module membership only from module labels, never from a plain label', async () => {
    const plain = await createPlainLabel('bug');
    await createModule('alpha');
    await attach(await insertIssue(), plain, false);

    const r = await rollup();
    expect(moduleNamed(r, 'alpha').own.secondary.total).toBe(0);
    expect(r.unassigned.total).toBe(1);
  });

  it('reports an issue with no module in the unassigned bucket and in no module', async () => {
    const alpha = await createModule('alpha');
    await attach(await insertIssue(), alpha, true);
    await insertIssue();

    const r = await rollup();
    expect(r.unassigned.total).toBe(1);
    expect(moduleNamed(r, 'alpha').rollup.primary.total).toBe(1);
  });

  it('keeps an issue that HAS a module out of the unassigned bucket', async () => {
    const alpha = await createModule('alpha');
    const issueId = await insertIssue();
    await attach(issueId, alpha, true);
    await attach(issueId, await createPlainLabel('bug'));

    expect((await rollup()).unassigned.total).toBe(0);
  });

  it('presents a module with no issues at all, with every count zero', async () => {
    await createModule('empty');

    const row = moduleNamed(await rollup(), 'empty');
    expect(row.own.primary).toEqual({ total: 0, open: 0, closed: 0, recentlyActive: 0 });
    expect(row.rollup.secondary.total).toBe(0);
  });

  it("leaves another project's issues out entirely", async () => {
    const alpha = await createModule('alpha');
    const other = await createTestProject(harness.db, user.id);
    const otherIssue = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${otherIssue}, ${other.id}, 991234, 'Elsewhere', 'open', ${user.id})
    `);
    await attach(otherIssue, alpha, true);

    const r = await rollup();
    expect(r.unassigned.total).toBe(0);
    expect(moduleNamed(r, 'alpha').own.primary.total).toBe(0);
  });
});

describe('ISS-949 · open, closed and recent activity', () => {
  it('counts released, closed and dropped as closed and every other status as open', async () => {
    const alpha = await createModule('alpha');
    for (const status of ['released', 'closed', 'dropped']) {
      await attach(await insertIssue(status), alpha);
    }
    for (const status of ['open', 'in_progress', 'draft', 'on_hold']) {
      await attach(await insertIssue(status), alpha);
    }

    const row = moduleNamed(await rollup(), 'alpha');
    expect(row.own.secondary).toMatchObject({ total: 7, closed: 3, open: 4 });
  });

  it('counts as recently active only the issues updated inside the window', async () => {
    const alpha = await createModule('alpha');
    await attach(await insertIssue('open', 2), alpha);
    await attach(await insertIssue('open', 45), alpha);

    const row = moduleNamed(await rollup(), 'alpha');
    expect(row.own.secondary.total).toBe(2);
    expect(row.own.secondary.recentlyActive).toBe(1);
  });

  it('moves the window with ?activeWithinDays', async () => {
    const alpha = await createModule('alpha');
    await attach(await insertIssue('open', 45), alpha);

    expect((await rollup()).activeWithinDays).toBe(30);
    const wide = await rollup('?activeWithinDays=90');
    expect(wide.activeWithinDays).toBe(90);
    expect(moduleNamed(wide, 'alpha').own.secondary.recentlyActive).toBe(1);
  });

  it('refuses a window of zero days', async () => {
    const res = await req(`/projects/${project.id}/modules/rollup?activeWithinDays=0`);
    expect(res.status).toBe(400);
  });
});

describe('ISS-949 · the hierarchy', () => {
  it("counts a child's issues in the parent's inherited and not in its own", async () => {
    const parent = await createModule('parent');
    const child = await createModule('child', parent);
    await attach(await insertIssue(), child, true);

    const row = moduleNamed(await rollup(), 'parent');
    expect(row.own.primary.total).toBe(0);
    expect(row.inherited.primary.total).toBe(1);
    expect(row.rollup.primary.total).toBe(1);
  });

  it('inherits from a grandchild too', async () => {
    const parent = await createModule('parent');
    const child = await createModule('child', parent);
    const grandchild = await createModule('grandchild', child);
    await attach(await insertIssue(), grandchild, true);

    expect(moduleNamed(await rollup(), 'parent').inherited.primary.total).toBe(1);
  });

  it('counts an issue attributed to both a parent and its child once in the parent', async () => {
    const parent = await createModule('parent');
    const child = await createModule('child', parent);
    const issueId = await insertIssue();
    await attach(issueId, parent);
    await attach(issueId, child);

    const row = moduleNamed(await rollup(), 'parent');
    expect(row.own.secondary.total).toBe(1);
    expect(row.inherited.secondary.total).toBe(0);
    expect(row.rollup.secondary.total).toBe(1);
  });

  it('reports depth so a reader can render the hierarchy', async () => {
    const parent = await createModule('parent');
    await createModule('child', parent);

    const r = await rollup();
    expect(moduleNamed(r, 'parent').depth).toBe(0);
    expect(moduleNamed(r, 'child').depth).toBe(1);
  });
});

describe('ISS-949 · access', () => {
  it('refuses a non-member with 403', async () => {
    const stranger = await createTestUser(harness.db);
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${stranger.id}`,
    );
    const strangerToken = await mods.signUserToken(stranger.id);

    const res = await req(`/projects/${project.id}/modules/rollup`, strangerToken);
    expect(res.status).toBe(403);
  });
});
