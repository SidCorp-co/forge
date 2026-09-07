/**
 * ISS-947 — the module registry's slug and its 1:1 knowledge-node binding, against a real Postgres.
 *
 * Every rule here is one a mocked client cannot fail: `labels_slug_chk` and
 * `labels_knowledge_entry_chk` refusing a plain label that carries either field,
 * `labels_knowledge_entry_id_uq` holding the 1:1, the FK's `ON DELETE SET NULL` clearing a link
 * rather than deleting a module, and migration 0215's backfill assigning a slug to modules that
 * existed before the column did.
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

// cm:guard assert the constraint NAME through the cause, never a regex over the message — drizzle wraps the driver error, so `.message` carries only the failed SQL and a regex over it matches nothing, leaving the case red whether or not the constraint exists and carrying no signal either way.
async function violatedConstraint(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { cause?: { constraint_name?: string } }).cause?.constraint_name;
  }
}

type Mods = {
  labelProjectRoutes: (typeof import('../../src/labels/routes.js'))['labelProjectRoutes'];
  labelRoutes: (typeof import('../../src/labels/routes.js'))['labelRoutes'];
  issueProjectRoutes: (typeof import('../../src/issues/routes.js'))['issueProjectRoutes'];
  issueRoutes: (typeof import('../../src/issues/routes.js'))['issueRoutes'];
  signUserToken: (typeof import('../../src/auth/jwt.js'))['signUserToken'];
  errorHandler: (typeof import('../../src/middleware/error.js'))['errorHandler'];
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

  const [labelMod, issueMod, jwtMod, errMod] = await Promise.all([
    import('../../src/labels/routes.js'),
    import('../../src/issues/routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
  ]);
  mods = {
    labelProjectRoutes: labelMod.labelProjectRoutes,
    labelRoutes: labelMod.labelRoutes,
    issueProjectRoutes: issueMod.issueProjectRoutes,
    issueRoutes: issueMod.issueRoutes,
    signUserToken: jwtMod.signUserToken,
    errorHandler: errMod.errorHandler,
  };

  app = new Hono();
  app.route('/api/projects', mods.labelProjectRoutes);
  app.route('/api/projects', mods.issueProjectRoutes);
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

type LabelBody = {
  id: string;
  name: string;
  kind: string;
  slug: string | null;
  knowledgeEntryId: string | null;
};

async function createLabel(body: Record<string, unknown>) {
  const res = await req(`/projects/${project.id}/labels`, { method: 'POST', body });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function createModule(name: string, extra: Record<string, unknown> = {}) {
  const { status, body } = await createLabel({ name, kind: 'module', ...extra });
  expect(status).toBe(201);
  return body as unknown as LabelBody;
}

async function createKnowledgeEntry(slug: string, projectId = project.id): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO knowledge_entries (id, project_id, kind, slug, title, body)
    VALUES (${id}, ${projectId}, 'reference', ${slug}, ${slug}, 'body')
  `);
  return id;
}

async function readLabelRow(id: string) {
  const rows = await harness.db.execute<{ slug: string | null; knowledge_entry_id: string | null }>(
    sql`SELECT slug, knowledge_entry_id FROM labels WHERE id = ${id}`,
  );
  return [...rows][0];
}

describe('ISS-947 · slug derivation', () => {
  it('derives a slug from the name when a module is created without one', async () => {
    const mod = await createModule('Pipeline Runs');
    expect(mod.slug).toBe('pipeline-runs');
  });

  it('collapses punctuation and case rather than carrying them into the identity', async () => {
    const mod = await createModule('  API/v2 — Core!!  ');
    expect(mod.slug).toBe('api-v2-core');
  });

  it('falls back to `module` for a name that derives no alphanumerics', async () => {
    const mod = await createModule('!!!');
    expect(mod.slug).toBe('module');
  });

  // cm:guard the two names are DISTINCT, so `labels_project_id_name_uq` does not refuse them and the collision reaches the slug — which is the whole case: name-uniqueness does not imply slug-uniqueness, and the epic's locked Q2 needs the slug unique per project.
  it('suffixes rather than refusing when two distinct names derive one base', async () => {
    const first = await createModule('API/v2');
    const second = await createModule('API v2');
    expect(first.slug).toBe('api-v2');
    expect(second.slug).toBe('api-v2-2');

    const third = await createModule('api  v2');
    expect(third.slug).toBe('api-v2-3');
  });

  it('leaves the slug byte-identical when the name changes', async () => {
    const mod = await createModule('Billing');
    const res = await req(`/labels/${mod.id}`, { method: 'PATCH', body: { name: 'Payments' } });
    expect(res.status).toBe(200);
    const patched = (await res.json()) as LabelBody;
    expect(patched.name).toBe('Payments');
    expect(patched.slug).toBe('billing');
  });

  it('refuses a caller-supplied slug rather than accepting or silently dropping it', async () => {
    const { status } = await createLabel({ name: 'Chosen', kind: 'module', slug: 'mine' });
    expect(status).toBe(400);
  });

  it('leaves a plain label with no slug and no node', async () => {
    const { status, body } = await createLabel({ name: 'bug', color: '#aabbcc' });
    expect(status).toBe(201);
    expect(body.slug).toBeNull();
    expect(body.knowledgeEntryId).toBeNull();
  });
});

describe('ISS-947 · the database refuses what the service refuses', () => {
  it('refuses a plain label carrying a slug', async () => {
    const constraint = await violatedConstraint(
      harness.db.execute(sql`
        INSERT INTO labels (id, project_id, name, color, kind, slug)
        VALUES (${randomUUID()}, ${project.id}, 'sneaky', '#aabbcc', 'label', 'sneaky')
      `),
    );
    expect(constraint).toBe('labels_slug_chk');
  });

  it('refuses a module with no slug', async () => {
    const constraint = await violatedConstraint(
      harness.db.execute(sql`
        INSERT INTO labels (id, project_id, name, color, kind)
        VALUES (${randomUUID()}, ${project.id}, 'slugless', '#aabbcc', 'module')
      `),
    );
    expect(constraint).toBe('labels_slug_chk');
  });

  it('refuses a plain label carrying a knowledge node', async () => {
    const node = await createKnowledgeEntry('module-orphan');
    const constraint = await violatedConstraint(
      harness.db.execute(sql`
        INSERT INTO labels (id, project_id, name, color, kind, knowledge_entry_id)
        VALUES (${randomUUID()}, ${project.id}, 'sneaky', '#aabbcc', 'label', ${node})
      `),
    );
    expect(constraint).toBe('labels_knowledge_entry_chk');
  });

  it('refuses two modules in one project sharing a slug', async () => {
    await createModule('Runs');
    const constraint = await violatedConstraint(
      harness.db.execute(sql`
        INSERT INTO labels (id, project_id, name, color, kind, slug)
        VALUES (${randomUUID()}, ${project.id}, 'Runs Two', '#aabbcc', 'module', 'runs')
      `),
    );
    expect(constraint).toBe('labels_project_id_slug_uq');
  });

  // cm:guard the same slug in a DIFFERENT project must be legal — the registry is per-project, and a unique index on `slug` alone rather than on `(project_id, slug)` would make the first project to name a module own that name everywhere.
  it('allows the same slug in another project', async () => {
    await createModule('Runs');
    const other = await createTestProject(harness.db, user.id);
    const constraint = await violatedConstraint(
      harness.db.execute(sql`
        INSERT INTO labels (id, project_id, name, color, kind, slug)
        VALUES (${randomUUID()}, ${other.id}, 'Runs', '#aabbcc', 'module', 'runs')
      `),
    );
    expect(constraint).toBeUndefined();
  });

  it('allows any number of modules with no node, because NULLs are distinct', async () => {
    await createModule('One');
    await createModule('Two');
    const rows = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM labels WHERE knowledge_entry_id IS NULL`,
    );
    expect([...rows][0]?.n).toBe(2);
  });
});

describe('ISS-947 · the 1:1 binding', () => {
  it('stores the node id and reads it back on the label projection', async () => {
    const node = await createKnowledgeEntry('module-billing');
    const mod = await createModule('Billing', { knowledgeEntryId: node });
    expect(mod.knowledgeEntryId).toBe(node);

    const listed = (await (await req(`/projects/${project.id}/labels`)).json()) as LabelBody[];
    expect(listed.find((l) => l.id === mod.id)?.knowledgeEntryId).toBe(node);
  });

  it('binds on PATCH as well as on create', async () => {
    const node = await createKnowledgeEntry('module-later');
    const mod = await createModule('Later');
    expect(mod.knowledgeEntryId).toBeNull();

    const res = await req(`/labels/${mod.id}`, {
      method: 'PATCH',
      body: { knowledgeEntryId: node },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as LabelBody).knowledgeEntryId).toBe(node);
  });

  it('refuses a second module naming a node another module already holds', async () => {
    const node = await createKnowledgeEntry('module-contested');
    await createModule('First', { knowledgeEntryId: node });
    const { status, body } = await createLabel({
      name: 'Second',
      kind: 'module',
      knowledgeEntryId: node,
    });
    expect(status).toBe(400);
    expect((body as { code?: string }).code).toBe('KNOWLEDGE_NODE_TAKEN');
  });

  it('lets a module re-assert the node it already holds', async () => {
    const node = await createKnowledgeEntry('module-idempotent');
    const mod = await createModule('Same', { knowledgeEntryId: node });
    const res = await req(`/labels/${mod.id}`, {
      method: 'PATCH',
      body: { knowledgeEntryId: node },
    });
    expect(res.status).toBe(200);
  });

  it('holds the 1:1 at the database when a writer bypasses the service', async () => {
    const node = await createKnowledgeEntry('module-db-held');
    await createModule('First', { knowledgeEntryId: node });
    const constraint = await violatedConstraint(
      harness.db.execute(sql`
        INSERT INTO labels (id, project_id, name, color, kind, slug, knowledge_entry_id)
        VALUES (${randomUUID()}, ${project.id}, 'Second', '#aabbcc', 'module', 'second', ${node})
      `),
    );
    expect(constraint).toBe('labels_knowledge_entry_id_uq');
  });

  it('refuses a node that does not exist', async () => {
    const { status, body } = await createLabel({
      name: 'Ghost',
      kind: 'module',
      knowledgeEntryId: randomUUID(),
    });
    expect(status).toBe(400);
    expect((body as { code?: string }).code).toBe('INVALID_KNOWLEDGE_NODE');
  });

  it('refuses a node belonging to another project by name', async () => {
    const other = await createTestProject(harness.db, user.id);
    const node = await createKnowledgeEntry('module-elsewhere', other.id);
    const { status, body } = await createLabel({
      name: 'Foreign',
      kind: 'module',
      knowledgeEntryId: node,
    });
    expect(status).toBe(400);
    expect((body as { code?: string }).code).toBe('KNOWLEDGE_NODE_NOT_IN_PROJECT');
  });

  it('refuses a plain label naming a node', async () => {
    const node = await createKnowledgeEntry('module-not-mine');
    const { status, body } = await createLabel({
      name: 'plain',
      color: '#aabbcc',
      knowledgeEntryId: node,
    });
    expect(status).toBe(400);
    expect((body as { code?: string }).code).toBe('KNOWLEDGE_NODE_ON_NON_MODULE');
  });
});

describe('ISS-947 · deletion on each side', () => {
  it('clears the link rather than deleting the module when the node goes', async () => {
    const node = await createKnowledgeEntry('module-doomed');
    const mod = await createModule('Survivor', { knowledgeEntryId: node });

    await harness.db.execute(sql`DELETE FROM knowledge_entries WHERE id = ${node}`);

    const row = await readLabelRow(mod.id);
    expect(row).toBeDefined();
    expect(row?.knowledge_entry_id).toBeNull();
    expect(row?.slug).toBe('survivor');
  });

  it('leaves the knowledge node standing when the module goes', async () => {
    const node = await createKnowledgeEntry('module-outlives');
    const mod = await createModule('Transient', { knowledgeEntryId: node });

    const res = await req(`/labels/${mod.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);

    const rows = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM knowledge_entries WHERE id = ${node}`,
    );
    expect([...rows][0]?.n).toBe(1);
  });
});

describe('ISS-947 · promotion and demotion', () => {
  it('derives the slug at the moment a plain label is promoted', async () => {
    const { body } = await createLabel({ name: 'Ops Tooling', color: '#aabbcc' });
    const id = (body as { id: string }).id;

    const res = await req(`/labels/${id}`, { method: 'PATCH', body: { kind: 'module' } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as LabelBody).slug).toBe('ops-tooling');
  });

  it('derives the promoted slug from the name in the SAME patch, not the stale one', async () => {
    const { body } = await createLabel({ name: 'Old Name', color: '#aabbcc' });
    const id = (body as { id: string }).id;

    const res = await req(`/labels/${id}`, {
      method: 'PATCH',
      body: { kind: 'module', name: 'New Name' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as LabelBody).slug).toBe('new-name');
  });

  it('clears both module-only fields on demotion', async () => {
    const node = await createKnowledgeEntry('module-demoted');
    const mod = await createModule('Temporary', { knowledgeEntryId: node });

    const res = await req(`/labels/${mod.id}`, { method: 'PATCH', body: { kind: 'label' } });
    expect(res.status).toBe(200);
    const demoted = (await res.json()) as LabelBody;
    expect(demoted.kind).toBe('label');
    expect(demoted.slug).toBeNull();
    expect(demoted.knowledgeEntryId).toBeNull();
  });

  it('frees the node for another module once the holder is demoted', async () => {
    const node = await createKnowledgeEntry('module-released');
    const mod = await createModule('Holder', { knowledgeEntryId: node });
    await req(`/labels/${mod.id}`, { method: 'PATCH', body: { kind: 'label' } });

    const next = await createModule('Next Holder', { knowledgeEntryId: node });
    expect(next.knowledgeEntryId).toBe(node);
  });
});

describe('ISS-947 · the issue-detail projection', () => {
  it('reports slug and knowledgeEntryId on every attached label', async () => {
    const node = await createKnowledgeEntry('module-attached');
    const mod = await createModule('Attached', { knowledgeEntryId: node });
    const { body: plain } = await createLabel({ name: 'plain', color: '#aabbcc' });

    const created = await req(`/projects/${project.id}/issues`, {
      method: 'POST',
      body: {
        title: 'An issue',
        labels: [{ labelId: mod.id, isPrimary: true }, (plain as { id: string }).id],
      },
    });
    expect(created.status).toBe(201);
    const issueId = ((await created.json()) as { id: string }).id;

    const detail = (await (await req(`/issues/${issueId}`)).json()) as {
      labels: Array<{ id: string; slug: string | null; knowledgeEntryId: string | null }>;
    };
    const module = detail.labels.find((l) => l.id === mod.id);
    expect(module?.slug).toBe('attached');
    expect(module?.knowledgeEntryId).toBe(node);
    const label = detail.labels.find((l) => l.id !== mod.id);
    expect(label?.slug).toBeNull();
    expect(label?.knowledgeEntryId).toBeNull();
  });
});

describe('ISS-947 · migration 0215 backfill', () => {
  // cm:guard the columns are DROPPED and re-added rather than the modules being inserted with a slug — the point is to reproduce the pre-migration table, where a module row exists and the column does not, which is the only state the backfill has to survive and the one a fresh test database never reaches on its own.
  it('assigns every pre-existing module a slug, and disambiguates a collision', async () => {
    await harness.db.execute(sql`ALTER TABLE labels DROP CONSTRAINT labels_slug_chk`);
    await harness.db.execute(sql`ALTER TABLE labels DROP CONSTRAINT labels_knowledge_entry_chk`);
    await harness.db.execute(sql`DROP INDEX labels_project_id_slug_uq`);
    await harness.db.execute(sql`ALTER TABLE labels DROP COLUMN slug`);

    for (const [name, at] of [
      ['API/v2', '2024-01-01'],
      ['API v2', '2024-01-02'],
      ['Plain Module', '2024-01-03'],
      ['!!!', '2024-01-04'],
    ] as const) {
      await harness.db.execute(sql`
        INSERT INTO labels (id, project_id, name, color, kind, created_at)
        VALUES (${randomUUID()}, ${project.id}, ${name}, '#aabbcc', 'module', ${`${at}T00:00:00Z`}::timestamptz)
      `);
    }
    await harness.db.execute(sql`
      INSERT INTO labels (id, project_id, name, color, kind)
      VALUES (${randomUUID()}, ${project.id}, 'a plain label', '#aabbcc', 'label')
    `);

    await harness.db.execute(sql`ALTER TABLE labels ADD COLUMN slug text`);
    await harness.db.execute(sql`
      UPDATE labels AS l
      SET slug = d.slug
      FROM (
        SELECT id, CASE WHEN rn = 1 THEN base ELSE base || '-' || rn END AS slug
        FROM (
          SELECT id, base,
                 row_number() OVER (PARTITION BY project_id, base ORDER BY created_at, id) AS rn
          FROM (
            SELECT id, project_id, created_at,
                   COALESCE(
                     NULLIF(TRIM(BOTH '-' FROM regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), ''),
                     'module'
                   ) AS base
            FROM labels WHERE kind = 'module'
          ) AS based
        ) AS numbered
      ) AS d
      WHERE l.id = d.id
    `);

    const rows = await harness.db.execute<{ name: string; slug: string | null; kind: string }>(
      sql`SELECT name, slug, kind FROM labels ORDER BY created_at, id`,
    );
    const bySlug = new Map([...rows].map((r) => [r.name, r.slug]));
    expect(bySlug.get('API/v2')).toBe('api-v2');
    expect(bySlug.get('API v2')).toBe('api-v2-2');
    expect(bySlug.get('Plain Module')).toBe('plain-module');
    expect(bySlug.get('!!!')).toBe('module');
    expect(bySlug.get('a plain label')).toBeNull();

    await harness.db.execute(
      sql`CREATE UNIQUE INDEX labels_project_id_slug_uq ON labels (project_id, slug)`,
    );
    const constraint = await violatedConstraint(
      harness.db.execute(
        sql`ALTER TABLE labels ADD CONSTRAINT labels_slug_chk CHECK ((kind = 'module') = (slug IS NOT NULL))`,
      ),
    );
    expect(constraint).toBeUndefined();
  });
});
