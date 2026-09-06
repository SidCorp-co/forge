/**
 * ISS-593 — the module taxonomy against a real Postgres.
 *
 * Everything here needs a database that can actually refuse: the partial unique index on
 * `issue_labels.is_primary`, the additive defaults migration 0213 leaves behind, and the
 * `kind='module'` predicate that separates `?module` from `?label`. A mocked client cannot
 * fail any of them, so a green from the unit suites is no evidence for these.
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

// cm:guard assert the constraint NAME through the cause, never a regex over the message — drizzle wraps the driver error, so `.message` carries only the failed SQL and the regex matches nothing, leaving the case red whether or not the constraint exists and carrying no signal either way. The name is green only when THAT constraint rejected, red both when nothing rejects and when a different one does.
async function violatedConstraint(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { cause?: { constraint_name?: string } }).cause?.constraint_name;
  }
}

type Mods = {
  labelProjectRoutes: typeof import('../../src/labels/routes.js')['labelProjectRoutes'];
  labelRoutes: typeof import('../../src/labels/routes.js')['labelRoutes'];
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
    labelRoutes: labelMod.labelRoutes,
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
  app.route('/api/labels', mods.labelRoutes);
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

const headers = () => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });

const req = (path: string, init?: { method?: string; body?: unknown }) =>
  app.request(`/api${path}`, {
    method: init?.method ?? 'GET',
    headers: headers(),
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

async function createLabel(body: Record<string, unknown>) {
  const res = await req(`/projects/${project.id}/labels`, { method: 'POST', body });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function createModule(name: string, extra: Record<string, unknown> = {}) {
  const { status, body } = await createLabel({ name, kind: 'module', ...extra });
  expect(status).toBe(201);
  return body as { id: string; name: string; color: string };
}

async function insertIssue(title = 'Issue'): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${project.id}, ${Math.floor(Math.random() * 1_000_000)},
            ${title}, 'open', ${user.id})
  `);
  return id;
}

async function junction(issueId: string) {
  const rows = await harness.db.execute<{ label_id: string; is_primary: boolean }>(
    sql`SELECT label_id, is_primary FROM issue_labels WHERE issue_id = ${issueId}`,
  );
  return [...rows];
}

describe('ISS-593 · migration 0210', () => {
  it('defaults a label row inserted without the new columns to kind=label, no parent', async () => {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO labels (id, project_id, name, color) VALUES (${id}, ${project.id}, 'legacy', '#aabbcc')
    `);
    const [row] = [
      ...(await harness.db.execute<{
        kind: string;
        parent_id: string | null;
        description: string | null;
      }>(sql`SELECT kind, parent_id, description FROM labels WHERE id = ${id}`)),
    ];
    expect(row).toMatchObject({ kind: 'label', parent_id: null, description: null });
  });

  it('defaults an issue_labels row inserted without is_primary to false', async () => {
    const issueId = await insertIssue();
    const label = await createLabel({ name: 'legacy', color: '#aabbcc' });
    await harness.db.execute(sql`
      INSERT INTO issue_labels (issue_id, label_id) VALUES (${issueId}, ${label.body.id as string})
    `);
    expect(await junction(issueId)).toEqual([{ label_id: label.body.id, is_primary: false }]);
  });

  // cm:guard the app layer is not the only thing holding this — a writer that bypasses `resolveLabelIdsForWrite` must still be refused, and this is the statement that refuses it
  it('refuses a second is_primary row for one issue at the database', async () => {
    const issueId = await insertIssue();
    const a = await createModule('alpha');
    const b = await createModule('beta');
    await harness.db.execute(sql`
      INSERT INTO issue_labels (issue_id, label_id, is_primary)
      VALUES (${issueId}, ${a.id}, true)
    `);
    expect(
      await violatedConstraint(
        harness.db.execute(sql`
        INSERT INTO issue_labels (issue_id, label_id, is_primary)
        VALUES (${issueId}, ${b.id}, true)
      `),
      ),
    ).toBe('issue_labels_primary_uq');
  });

  it('permits many non-primary rows for one issue', async () => {
    const issueId = await insertIssue();
    const a = await createModule('alpha');
    const b = await createModule('beta');
    await harness.db.execute(sql`
      INSERT INTO issue_labels (issue_id, label_id) VALUES (${issueId}, ${a.id}), (${issueId}, ${b.id})
    `);
    expect(await junction(issueId)).toHaveLength(2);
  });
});

describe('ISS-593 · module create and update', () => {
  it('auto-assigns a #rrggbb colour to a module created without one', async () => {
    const mod = await createModule('pipeline');
    expect(mod.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('still requires a colour on a plain label', async () => {
    const { status } = await createLabel({ name: 'bug' });
    expect(status).toBe(400);
  });

  it('stores kind, parentId and description', async () => {
    const parent = await createModule('core');
    const child = await createModule('core-db', {
      parentId: parent.id,
      description: 'the schema and its migrations',
    });
    expect(child).toMatchObject({
      kind: 'module',
      parentId: parent.id,
      description: 'the schema and its migrations',
    });
  });

  it('rejects a parent in another project with INVALID_PARENT', async () => {
    const other = await createTestProject(harness.db, user.id);
    const foreignId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO labels (id, project_id, name, color, kind)
      VALUES (${foreignId}, ${other.id}, 'elsewhere', '#aabbcc', 'module')
    `);
    const { status, body } = await createLabel({
      name: 'child',
      kind: 'module',
      parentId: foreignId,
    });
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_PARENT');
  });

  it('rejects a plain-label parent with PARENT_NOT_MODULE', async () => {
    const plain = await createLabel({ name: 'bug', color: '#aabbcc' });
    const { status, body } = await createLabel({
      name: 'child',
      kind: 'module',
      parentId: plain.body.id,
    });
    expect(status).toBe(400);
    expect(body.code).toBe('PARENT_NOT_MODULE');
  });

  it('rejects a parent that would close a cycle with CIRCULAR_HIERARCHY', async () => {
    const top = await createModule('top');
    const mid = await createModule('mid', { parentId: top.id });
    const res = await req(`/labels/${top.id}`, { method: 'PATCH', body: { parentId: mid.id } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('CIRCULAR_HIERARCHY');
  });

  it('rejects a module as its own parent', async () => {
    const mod = await createModule('solo');
    const res = await req(`/labels/${mod.id}`, { method: 'PATCH', body: { parentId: mod.id } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('CIRCULAR_HIERARCHY');
  });
});

describe('ISS-593 · primary module attach', () => {
  it('stores exactly the primary row the caller asked for', async () => {
    const issueId = await insertIssue();
    const mod = await createModule('pipeline');
    const res = await req(`/issues/${issueId}`, {
      method: 'PATCH',
      body: { labels: [{ labelId: 'pipeline', isPrimary: true }] },
    });
    expect(res.status).toBe(200);
    expect(await junction(issueId)).toEqual([{ label_id: mod.id, is_primary: true }]);
  });

  it('swaps the primary atomically, leaving exactly one', async () => {
    const issueId = await insertIssue();
    await createModule('pipeline');
    const next = await createModule('issues');
    await req(`/issues/${issueId}`, {
      method: 'PATCH',
      body: { labels: [{ labelId: 'pipeline', isPrimary: true }] },
    });
    await req(`/issues/${issueId}`, {
      method: 'PATCH',
      body: { labels: [{ labelId: 'issues', isPrimary: true }] },
    });
    expect(await junction(issueId)).toEqual([{ label_id: next.id, is_primary: true }]);
  });

  it('refuses a plain label marked primary, and writes nothing', async () => {
    const issueId = await insertIssue();
    await createLabel({ name: 'bug', color: '#aabbcc' });
    const res = await req(`/issues/${issueId}`, {
      method: 'PATCH',
      body: { labels: [{ labelId: 'bug', isPrimary: true }] },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('PRIMARY_NOT_MODULE');
    expect(await junction(issueId)).toEqual([]);
  });

  it('refuses two primaries in one set, and writes nothing', async () => {
    const issueId = await insertIssue();
    await createModule('pipeline');
    await createModule('issues');
    const res = await req(`/issues/${issueId}`, {
      method: 'PATCH',
      body: {
        labels: [
          { labelId: 'pipeline', isPrimary: true },
          { labelId: 'issues', isPrimary: true },
        ],
      },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('MULTIPLE_PRIMARY');
    expect(await junction(issueId)).toEqual([]);
  });

  it('keeps the bare-string form attaching a non-primary label', async () => {
    const issueId = await insertIssue();
    const plain = await createLabel({ name: 'bug', color: '#aabbcc' });
    const res = await req(`/issues/${issueId}`, { method: 'PATCH', body: { labels: ['bug'] } });
    expect(res.status).toBe(200);
    expect(await junction(issueId)).toEqual([{ label_id: plain.body.id, is_primary: false }]);
  });

  it('reports kind and isPrimary on every label of the issue detail', async () => {
    const issueId = await insertIssue();
    await createModule('pipeline');
    await createLabel({ name: 'bug', color: '#aabbcc' });
    await req(`/issues/${issueId}`, {
      method: 'PATCH',
      body: { labels: ['bug', { labelId: 'pipeline', isPrimary: true }] },
    });
    const detail = (await (await req(`/issues/${issueId}`)).json()) as {
      labels: Array<{ name: string; kind: string; isPrimary: boolean }>;
    };
    expect([...detail.labels].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      expect.objectContaining({ name: 'bug', kind: 'label', isPrimary: false }),
      expect.objectContaining({ name: 'pipeline', kind: 'module', isPrimary: true }),
    ]);
  });
});

describe('ISS-593 · search ?module', () => {
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
    const body = (await res.json()) as { items: Array<{ id: string }>; total: number };
    return body;
  };

  it('returns exactly the issues carrying the module, by name', async () => {
    const { tagged } = await seedTwoIssues();
    const body = await search('module=pipeline');
    expect(body.items.map((i) => i.id)).toEqual([tagged]);
  });

  it('returns the same set by uuid', async () => {
    const { mod, tagged } = await seedTwoIssues();
    const body = await search(`module=${mod.id}`);
    expect(body.items.map((i) => i.id)).toEqual([tagged]);
  });

  // cm:guard an unresolved module must return NOTHING — the failure this catches is the filter being dropped, which hands back every issue in the project and reads as "nothing matched"
  it('returns no issues for a module name that exists nowhere', async () => {
    await seedTwoIssues();
    const body = await search('module=no-such-module');
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('returns no issues for the name of a PLAIN label', async () => {
    await seedTwoIssues();
    const body = await search('module=bug');
    expect(body.items).toEqual([]);
  });

  it('leaves ?label answering as it did before, on a plain label id', async () => {
    const { untagged } = await seedTwoIssues();
    const labels = (await (await req(`/projects/${project.id}/labels`)).json()) as Array<{
      id: string;
      name: string;
    }>;
    const bug = labels.find((l) => l.name === 'bug');
    const body = await search(`label=${bug?.id}`);
    expect(body.items.map((i) => i.id)).toEqual([untagged]);
  });
});

describe('ISS-593 · kind changes after creation', () => {
  it('promotes an existing plain label to a module', async () => {
    const plain = await createLabel({ name: 'bug', color: '#aabbcc' });
    const res = await req(`/labels/${plain.body.id as string}`, {
      method: 'PATCH',
      body: { kind: 'module' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe('module');
  });

  it('refuses to demote a module that is some issue primary, with MODULE_IN_USE', async () => {
    const issueId = await insertIssue();
    const mod = await createModule('pipeline');
    await req(`/issues/${issueId}`, {
      method: 'PATCH',
      body: { labels: [{ labelId: 'pipeline', isPrimary: true }] },
    });
    const res = await req(`/labels/${mod.id}`, { method: 'PATCH', body: { kind: 'label' } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('MODULE_IN_USE');
  });

  it('refuses to demote a module that still parents another, with MODULE_IN_USE', async () => {
    const parent = await createModule('core');
    await createModule('core-db', { parentId: parent.id });
    const res = await req(`/labels/${parent.id}`, { method: 'PATCH', body: { kind: 'label' } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('MODULE_IN_USE');
  });

  it('demotes a module nothing depends on', async () => {
    const mod = await createModule('unused');
    const res = await req(`/labels/${mod.id}`, { method: 'PATCH', body: { kind: 'label' } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe('label');
  });
});

describe('ISS-593 · deleting a parent module', () => {
  // cm:guard `parent_id` is ON DELETE SET NULL, never cascade — a cascade would delete every descendant module and with it every issue's attribution to one, and no caller asked for that
  it('orphans its children rather than deleting them', async () => {
    const parent = await createModule('core');
    const child = await createModule('core-db', { parentId: parent.id });

    const res = await req(`/labels/${parent.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);

    const rows = [
      ...(await harness.db.execute<{ id: string; parent_id: string | null }>(
        sql`SELECT id, parent_id FROM labels WHERE id = ${child.id}`,
      )),
    ];
    expect(rows).toEqual([{ id: child.id, parent_id: null }]);
  });
});

describe('ISS-593 · parentId belongs to modules only', () => {
  it('refuses creating a plain label with a parent', async () => {
    const parent = await createModule('core');
    const { status, body } = await createLabel({
      name: 'bug',
      color: '#aabbcc',
      parentId: parent.id,
    });
    expect(status).toBe(400);
    expect(body.code).toBe('PARENT_ON_NON_MODULE');
  });

  it('refuses demoting a parented module, which would leave the parent meaningless', async () => {
    const parent = await createModule('core');
    const child = await createModule('core-db', { parentId: parent.id });
    const res = await req(`/labels/${child.id}`, { method: 'PATCH', body: { kind: 'label' } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('PARENT_ON_NON_MODULE');
  });

  it('demotes a parented module once its parent is cleared in the same request', async () => {
    const parent = await createModule('core');
    const child = await createModule('core-db', { parentId: parent.id });
    const res = await req(`/labels/${child.id}`, {
      method: 'PATCH',
      body: { kind: 'label', parentId: null },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { kind: string; parentId: null }).toMatchObject({
      kind: 'label',
      parentId: null,
    });
  });
});

describe('ISS-593 · labels_kind_chk', () => {
  // cm:guard `text(col,{enum})` emits no constraint, so this CHECK is the only thing stopping a writer that skips `labels/routes.ts` — a row with a third kind filters as no module and renders as no label, and nothing reports it
  it('refuses a kind that is neither label nor module, at the database', async () => {
    expect(
      await violatedConstraint(
        harness.db.execute(sql`
        INSERT INTO labels (id, project_id, name, color, kind)
        VALUES (${randomUUID()}, ${project.id}, 'weird', '#aabbcc', 'component')
      `),
      ),
    ).toBe('labels_kind_chk');
  });
});
