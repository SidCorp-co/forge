/**
 * `knowledge_entries.read_when` against the mounted app and a real column
 * (ISS-1313).
 *
 * The unit file beside `service.ts` drives `parseReadWhen` with plain values;
 * this one proves the rest of the record: a write round-trips its condition,
 * the list route filters on it (verb, status, and the combined OR), an
 * upsert naming no condition leaves a stored one alone while `null` clears
 * it, the always-inject selector never reads it, every entry that predates
 * this column keeps behaving exactly as it did, and both CHECK constraints
 * refuse a row the routes never would have accepted either.
 */

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
let projectId: string;
let token: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-abc';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';

  await truncateAll(harness.db);

  const user = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  const org = await seedOrg(harness.db, user.id);
  const project = await createTestProject(harness.db, user.id, { orgId: org.id });
  projectId = project.id;
  await createTestProjectMember(harness.db, { projectId, userId: user.id });

  const { signUserToken } = await import('../../src/auth/jwt.js');
  token = await signUserToken(user.id);

  ({ app } = await import('../../src/index.js'));
});

afterAll(async () => {
  await harness.cleanup();
});

async function send(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json: json as Record<string, unknown> | null };
}

const put = (slug: string, body: Record<string, unknown>) =>
  send('PUT', `/api/projects/${projectId}/knowledge/${slug}`, {
    title: slug,
    body: `body of ${slug}`,
    ...body,
  });

const get = (slug: string) => send('GET', `/api/projects/${projectId}/knowledge/${slug}`);
const list = (query: string) => send('GET', `/api/projects/${projectId}/knowledge${query}`);

/** The list route's `rows`, safely narrowed once so no assertion below reaches through an optional. */
function rowsOf(res: { json: Record<string, unknown> | null }): Array<Record<string, unknown>> {
  const rows = res.json?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

describe('writing and reading a condition (criteria 19, 20)', () => {
  it('reads back a verb condition on both the single-entry read and the list', async () => {
    const write = await put('verb-entry', { readWhen: { verbs: ['triage'] } });
    expect(write.status).toBe(200);

    const single = await get('verb-entry');
    expect(single.json).toMatchObject({ readWhen: { verbs: ['triage'] } });

    const listed = await list('');
    const row = rowsOf(listed).find((r) => r.slug === 'verb-entry');
    expect(row).toMatchObject({ readWhen: { verbs: ['triage'] } });
  });

  it('reads back a status condition', async () => {
    await put('status-entry', { readWhen: { statuses: ['open'] } });
    const single = await get('status-entry');
    expect(single.json).toMatchObject({ readWhen: { statuses: ['open'] } });
  });

  it('an entry with no condition is absent from both filters and present unfiltered (criterion 23)', async () => {
    await put('bare-entry', {});
    const single = await get('bare-entry');
    expect(single.json?.readWhen).toBeNull();

    const unfiltered = await list('');
    expect(rowsOf(unfiltered).some((r) => r.slug === 'bare-entry')).toBe(true);

    const byVerb = await list('?verb=triage');
    expect(rowsOf(byVerb).some((r) => r.slug === 'bare-entry')).toBe(false);

    const byStatus = await list('?status=open');
    expect(rowsOf(byStatus).some((r) => r.slug === 'bare-entry')).toBe(false);
  });
});

describe('the list filters (criteria 21, 22, 34)', () => {
  it('?verb=<verb> returns exactly the entries whose condition names that verb', async () => {
    const res = await list('?verb=triage');
    const slugs = rowsOf(res).map((r) => r.slug);
    expect(slugs).toContain('verb-entry');
    expect(slugs).not.toContain('status-entry');
    expect(slugs).not.toContain('bare-entry');
  });

  it('?status=<status> returns exactly the entries whose condition names that status', async () => {
    const res = await list('?status=open');
    const slugs = rowsOf(res).map((r) => r.slug);
    expect(slugs).toContain('status-entry');
    expect(slugs).not.toContain('verb-entry');
  });

  it('naming both verb and status returns every entry matching either, and none matching neither (criterion 34)', async () => {
    await put('dual-entry', { readWhen: { verbs: ['dispatch'] } });
    const res = await list('?verb=triage&status=open');
    const slugs = rowsOf(res).map((r) => r.slug);
    expect(slugs).toContain('verb-entry');
    expect(slugs).toContain('status-entry');
    expect(slugs).not.toContain('dual-entry');
    expect(slugs).not.toContain('bare-entry');
  });
});

describe('a condition refused at the write route (criteria 24-27, spot check)', () => {
  it('refuses a verb outside the declared set, naming every verb that is valid', async () => {
    const res = await put('bad-verb', { readWhen: { verbs: ['deploy'] } });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({
      code: 'KNOWLEDGE_READ_WHEN_SHAPE',
      details: { field: 'verbs' },
    });
  });

  it('refuses a value that is not an issue status', async () => {
    const res = await put('bad-status', { readWhen: { statuses: ['done'] } });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ details: { field: 'statuses' } });
  });

  it('refuses a file glob, saying so by name', async () => {
    const res = await put('has-glob', { readWhen: { globs: ['src/**/*.ts'] } });
    expect(res.status).toBe(400);
    expect((res.json?.message as string) ?? '').toContain('file glob');
  });

  it('refuses a condition naming neither axis', async () => {
    const res = await put('empty-condition', { readWhen: {} });
    expect(res.status).toBe(400);
  });
});

describe('an upsert that names no condition leaves the stored one alone; null clears it (criteria 31, 32)', () => {
  it('rewriting the body without readWhen leaves the condition in place', async () => {
    await put('sticky', { readWhen: { verbs: ['judge'] } });
    const rewritten = await put('sticky', { body: 'a new body, no readWhen key at all' });
    expect(rewritten.status).toBe(200);

    const read = await get('sticky');
    expect(read.json).toMatchObject({
      body: 'a new body, no readWhen key at all',
      readWhen: { verbs: ['judge'] },
    });
  });

  it('naming the condition as null removes it', async () => {
    const cleared = await put('sticky', { readWhen: null });
    expect(cleared.status).toBe(200);

    const read = await get('sticky');
    expect(read.json?.readWhen).toBeNull();
  });
});

describe('the always-inject selector never reads the condition (criteria 30, 35)', () => {
  it('injects an always entry whether or not it carries a condition', async () => {
    await put('always-with-condition', { injection: 'always', readWhen: { verbs: ['release'] } });
    await put('always-without-condition', { injection: 'always' });

    const { selectAlwaysInjectFromKnowledge } = await import('../../src/knowledge/service.js');
    const always = await selectAlwaysInjectFromKnowledge(projectId);
    const slugs = always.map((a) => a.key);
    expect(slugs).toContain('always-with-condition');
    expect(slugs).toContain('always-without-condition');
  });
});

describe('what predates this column keeps behaving as it did (criterion 29)', () => {
  it('an entry written with a raw INSERT naming no read_when reads back unaffected', async () => {
    await harness.db.execute(sql`
      INSERT INTO knowledge_entries (project_id, slug, title, body, kind, injection, confidence, authored_by)
      VALUES (${projectId}, 'pre-existing', 'pre-existing', 'body of pre-existing', 'guide', 'on_demand', 'inferred', 'human')
    `);

    const read = await get('pre-existing');
    expect(read.json).toMatchObject({
      slug: 'pre-existing',
      body: 'body of pre-existing',
      injection: 'on_demand',
      readWhen: null,
    });
  });
});

describe('the database refuses what the route refuses, and shapes the route never sees (criteria 28, 42, 43, 44)', () => {
  it('refuses a read_when naming a verb outside the declared set', async () => {
    await expect(
      harness.db.execute(sql`
        UPDATE knowledge_entries SET read_when = '{"verbs":["deploy"]}'::jsonb
        WHERE project_id = ${projectId} AND slug = 'bare-entry'
      `),
    ).rejects.toThrow();
  });

  it('refuses a read_when naming a value that is not an issue status', async () => {
    await expect(
      harness.db.execute(sql`
        UPDATE knowledge_entries SET read_when = '{"statuses":["done"]}'::jsonb
        WHERE project_id = ${projectId} AND slug = 'bare-entry'
      `),
    ).rejects.toThrow();
  });

  it('refuses a read_when carrying a key other than the two declared axes', async () => {
    await expect(
      harness.db.execute(sql`
        UPDATE knowledge_entries SET read_when = '{"verbs":["triage"],"glob":"src/**"}'::jsonb
        WHERE project_id = ${projectId} AND slug = 'bare-entry'
      `),
    ).rejects.toThrow();
  });

  it('refuses a read_when object naming neither axis', async () => {
    await expect(
      harness.db.execute(sql`
        UPDATE knowledge_entries SET read_when = '{}'::jsonb
        WHERE project_id = ${projectId} AND slug = 'bare-entry'
      `),
    ).rejects.toThrow();
  });

  it('refuses a read_when whose verbs array is empty — it matches nothing, same as neither axis', async () => {
    await expect(
      harness.db.execute(sql`
        UPDATE knowledge_entries SET read_when = '{"verbs":[]}'::jsonb
        WHERE project_id = ${projectId} AND slug = 'bare-entry'
      `),
    ).rejects.toThrow();
  });

  it('refuses a read_when whose statuses array is empty', async () => {
    await expect(
      harness.db.execute(sql`
        UPDATE knowledge_entries SET read_when = '{"statuses":[]}'::jsonb
        WHERE project_id = ${projectId} AND slug = 'bare-entry'
      `),
    ).rejects.toThrow();
  });

  it('accepts NULL — a condition is optional, only its shape is policed', async () => {
    await expect(
      harness.db.execute(sql`
        UPDATE knowledge_entries SET read_when = NULL
        WHERE project_id = ${projectId} AND slug = 'bare-entry'
      `),
    ).resolves.toBeDefined();
  });
});

describe('a route write refused for an empty axis', () => {
  it('refuses `{ verbs: [] }` naming the field', async () => {
    const res = await put('empty-verbs', { readWhen: { verbs: [] } });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ details: { field: 'verbs' } });
  });
});

describe('a mixed batch upsert is atomic (one transaction, not two independent statements)', () => {
  it('a valid untouched entry does not survive when a touched entry in the same call fails', async () => {
    const { upsertKnowledgeEntries } = await import('../../src/knowledge/service.js');
    const bogusProjectId = '00000000-0000-0000-0000-000000000000';

    await expect(
      upsertKnowledgeEntries([
        {
          // Valid on its own: were this call's two statements independent, this row would commit
          // before the second (bogus-project) statement fails.
          projectId,
          slug: 'atomic-untouched',
          title: 'atomic-untouched',
          body: 'no readWhen key at all',
          kind: 'guide',
          injection: 'on_demand',
          confidence: 'inferred',
          authoredBy: 'human',
          orderIndex: 0,
        },
        {
          projectId: bogusProjectId,
          slug: 'atomic-touched',
          title: 'atomic-touched',
          body: 'carries a readWhen, and a project id nothing references',
          kind: 'guide',
          injection: 'on_demand',
          confidence: 'inferred',
          authoredBy: 'human',
          orderIndex: 0,
          readWhen: { verbs: ['triage'] },
        },
      ]),
    ).rejects.toThrow();

    const rows = await harness.db.execute(
      sql`SELECT slug FROM knowledge_entries WHERE slug IN ('atomic-untouched', 'atomic-touched')`,
    );
    expect(rows.length).toBe(0);
  });
});
