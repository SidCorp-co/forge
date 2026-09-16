/**
 * ISS-1017 — `?withDependencies=1` on the issues search endpoint, against a
 * real Postgres.
 *
 * The sibling unit suites stub the database, so what they can prove is the
 * opt-in and the graft. What only a real database can answer is whether the
 * one query this replaced 25 with actually returns the edges: the `OR` over
 * the two endpoint columns, the `project_id` scope, and the per-endpoint
 * project prefix on an edge whose two ends live in different projects — which
 * no writer can create, so it is inserted here by hand.
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
  searchRoutes: typeof import('../../src/issues/search.js')['searchRoutes'];
  issueDependencyRoutes: typeof import('../../src/issues/dependency-routes.js')['issueDependencyRoutes'];
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

  const [searchMod, depMod, jwtMod, errMod] = await Promise.all([
    import('../../src/issues/search.js'),
    import('../../src/issues/dependency-routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
  ]);
  mods = {
    searchRoutes: searchMod.searchRoutes,
    issueDependencyRoutes: depMod.issueDependencyRoutes,
    signUserToken: jwtMod.signUserToken,
    errorHandler: errMod.errorHandler,
  };

  app = new Hono();
  app.route('/api/projects', mods.searchRoutes);
  app.route('/api/issues', mods.issueDependencyRoutes);
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

const req = (path: string) =>
  app.request(`/api${path}`, {
    method: 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });

type Row = {
  id: string;
  title: string;
  dependencies?: { outgoing: Edge[]; incoming: Edge[] };
};
type Edge = {
  id: string;
  kind: string;
  fromIssueId: string;
  toIssueId: string;
  fromDisplayId: string | null;
  toDisplayId: string | null;
  fromTitle: string | null;
  toTitle: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  fromMergedAt: string | null;
  toMergedAt: string | null;
  reason: string | null;
  validUntil: string | null;
  createdAt: string;
};

let seq = 0;
async function insertIssue(title: string, projectId = project.id): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${title}, 'open', ${user.id})
  `);
  return id;
}

async function insertEdge(opts: {
  from: string;
  to: string;
  projectId?: string;
  kind?: string;
  reason?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind, reason, created_by_id)
    VALUES (${id}, ${opts.projectId ?? project.id}, ${opts.from}, ${opts.to},
            ${opts.kind ?? 'blocks'}, ${opts.reason ?? null}, ${user.id})
  `);
  return id;
}

async function setPrefix(projectId: string, prefix: string): Promise<void> {
  await harness.db.execute(
    sql`INSERT INTO issue_prefix_aliases (project_id, prefix) VALUES (${projectId}, ${prefix})`,
  );
  await harness.db.execute(
    sql`UPDATE projects SET issue_prefix = ${prefix} WHERE id = ${projectId}`,
  );
}

const search = async (qs: string): Promise<Row[]> => {
  const res = await req(`/projects/${project.id}/issues/search${qs}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Row[] }).items;
};

const byTitle = (rows: Row[], title: string): Row => {
  const row = rows.find((r) => r.title === title);
  if (!row) throw new Error(`no row titled ${title}`);
  return row;
};

describe('ISS-1017 · search ?withDependencies against a real database', () => {
  it('returns no dependencies key at all when the caller does not opt in', async () => {
    const a = await insertIssue('a');
    const b = await insertIssue('b');
    await insertEdge({ from: a, to: b });
    const rows = await search('');
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).not.toHaveProperty('dependencies');
  });

  it('files one edge on both of the rows it joins, in the right direction', async () => {
    const blocker = await insertIssue('blocker');
    const blocked = await insertIssue('blocked');
    const edgeId = await insertEdge({ from: blocker, to: blocked });
    const rows = await search('?withDependencies=1');

    expect(byTitle(rows, 'blocker').dependencies?.outgoing.map((e) => e.id)).toEqual([edgeId]);
    expect(byTitle(rows, 'blocker').dependencies?.incoming).toEqual([]);
    expect(byTitle(rows, 'blocked').dependencies?.incoming.map((e) => e.id)).toEqual([edgeId]);
    expect(byTitle(rows, 'blocked').dependencies?.outgoing).toEqual([]);
  });

  it('finds the edge through to_issue_id when only the blocked end is on the page', async () => {
    const hidden = await insertIssue('hidden-blocker');
    const shown = await insertIssue('shown-dependent');
    const edgeId = await insertEdge({ from: hidden, to: shown });
    const rows = await search('?withDependencies=1&q=shown-dependent');
    expect(rows.map((r) => r.title)).toEqual(['shown-dependent']);
    expect(byTitle(rows, 'shown-dependent').dependencies?.incoming.map((e) => e.id)).toEqual([
      edgeId,
    ]);
  });

  it('finds the edge through from_issue_id when only the blocking end is on the page', async () => {
    const shown = await insertIssue('shown-blocker');
    const hidden = await insertIssue('hidden-dependent');
    const edgeId = await insertEdge({ from: shown, to: hidden });
    const rows = await search('?withDependencies=1&q=shown-blocker');
    expect(rows.map((r) => r.title)).toEqual(['shown-blocker']);
    expect(byTitle(rows, 'shown-blocker').dependencies?.outgoing.map((e) => e.id)).toEqual([
      edgeId,
    ]);
  });

  it('gives an issue with no edges both arrays rather than no key', async () => {
    await insertIssue('lonely');
    const [row] = await search('?withDependencies=1');
    expect(row?.dependencies).toEqual({ outgoing: [], incoming: [] });
  });

  it('carries the enriched edge the single-issue endpoint carries, field for field', async () => {
    const a = await insertIssue('a');
    const b = await insertIssue('b');
    await insertEdge({ from: a, to: b, reason: 'the schema lands first' });

    const fromList = byTitle(await search('?withDependencies=1'), 'a').dependencies?.outgoing[0];
    const one = await req(`/issues/${a}/dependencies`);
    const fromEndpoint = ((await one.json()) as { outgoing: Edge[] }).outgoing[0];
    expect(fromList).toEqual(fromEndpoint);
  });

  it("names an endpoint in another project with that project's prefix", async () => {
    const other = await createTestProject(harness.db, user.id);
    await setPrefix(project.id, 'FD');
    await setPrefix(other.id, 'FX');
    const here = await insertIssue('here');
    const there = await insertIssue('there', other.id);
    await insertEdge({ from: here, to: there });

    const edge = byTitle(await search('?withDependencies=1'), 'here').dependencies?.outgoing[0];
    expect(edge?.fromDisplayId?.startsWith('FD-')).toBe(true);
    expect(edge?.toDisplayId?.startsWith('FX-')).toBe(true);
  });

  it('leaves an edge scoped to another project out of this page', async () => {
    const other = await createTestProject(harness.db, user.id);
    const a = await insertIssue('a');
    const b = await insertIssue('b');
    await insertEdge({ from: a, to: b, projectId: other.id });
    const rows = await search('?withDependencies=1');
    expect(byTitle(rows, 'a').dependencies).toEqual({ outgoing: [], incoming: [] });
    expect(byTitle(rows, 'b').dependencies).toEqual({ outgoing: [], incoming: [] });
  });

  it('hydrates a whole page of issues without one query per row', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push(await insertIssue(`row-${i}`));
    for (let i = 1; i < 25; i++) await insertEdge({ from: ids[0] as string, to: ids[i] as string });
    const rows = await search('?withDependencies=1&limit=25');
    expect(rows).toHaveLength(25);
    expect(byTitle(rows, 'row-0').dependencies?.outgoing).toHaveLength(24);
    for (let i = 1; i < 25; i++) {
      expect(byTitle(rows, `row-${i}`).dependencies?.incoming).toHaveLength(1);
    }
  });
});
