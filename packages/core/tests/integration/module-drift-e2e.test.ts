/**
 * ISS-951 (Tier 3d) — the drift signal's SQL half, against a real Postgres.
 *
 * The set difference and the threshold are unit-tested in `src/labels/module-drift.test.ts` with
 * no database at all. Everything here is something a mocked client cannot fail: the self-join's
 * `kind='module'` filter on BOTH sides, the pair canonicalisation that stops each edge arriving
 * twice, distinct-issue counting, the `is_primary` anchor, and the project scope.
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
  moduleDrift: typeof import('../../src/labels/module-drift.js')['moduleDrift'];
  observedModuleEdges: typeof import('../../src/labels/module-drift.js')['observedModuleEdges'];
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

  const [labelMod, driftMod, jwtMod, errMod] = await Promise.all([
    import('../../src/labels/routes.js'),
    import('../../src/labels/module-drift.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
  ]);
  mods = {
    labelProjectRoutes: labelMod.labelProjectRoutes,
    moduleDrift: driftMod.moduleDrift,
    observedModuleEdges: driftMod.observedModuleEdges,
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

let seq = 1000;

/**
 * `id` is settable because the self-join canonicalises each pair as `right.label_id >
 * left.label_id`, so which side of a pair a row lands on depends on its uuid. A fixture that let
 * `randomUUID` decide asserted one of the two orderings at random: measured on ISS-951, dropping
 * the RIGHT side's `kind='module'` join left the plain-label case green half the time.
 */
async function insertModule(
  name: string,
  opts: { parentId?: string; projectId?: string; id?: string } = {},
): Promise<string> {
  const id = opts.id ?? randomUUID();
  await harness.db.execute(sql`
    INSERT INTO labels (id, project_id, name, color, kind, slug, parent_id)
    VALUES (${id}, ${opts.projectId ?? project.id}, ${name}, '#1f6f4a', 'module',
            ${name.toLowerCase()}, ${opts.parentId ?? null})
  `);
  return id;
}

async function insertPlainLabel(name: string, id: string = randomUUID()): Promise<string> {
  await harness.db.execute(sql`
    INSERT INTO labels (id, project_id, name, color) VALUES (${id}, ${project.id}, ${name}, '#aabbcc')
  `);
  return id;
}

async function insertIssue(opts: { projectId?: string } = {}): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${opts.projectId ?? project.id}, ${seq}, ${`Issue ${seq}`}, 'open', ${user.id})
  `);
  return id;
}

async function attach(issueId: string, labelId: string, isPrimary = false): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO issue_labels (issue_id, label_id, is_primary)
    VALUES (${issueId}, ${labelId}, ${isPrimary})
  `);
}

/** One issue carrying every id given, the first as its primary. */
async function issueOn(labelIds: string[], opts: { projectId?: string } = {}): Promise<string> {
  const issueId = await insertIssue(opts);
  for (const [i, labelId] of labelIds.entries()) await attach(issueId, labelId, i === 0);
  return issueId;
}

const drift = () => mods.moduleDrift(project.id, { minCoOccurrence: 1 });

const uuidAt = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('the observed self-join (ISS-951)', () => {
  it('reports a pair of modules sharing an issue exactly once, not once per direction', async () => {
    const a = await insertModule('alpha');
    const b = await insertModule('beta');
    await issueOn([a, b]);

    const edges = await mods.observedModuleEdges(project.id);
    expect(edges).toHaveLength(1);
    expect(new Set([edges[0]?.aLabelId, edges[0]?.bLabelId])).toEqual(new Set([a, b]));
    expect(edges[0]?.issueCount).toBe(1);
  });

  // cm:guard `issue_labels` cannot see `labels.kind`, so this is the only place the plain-label case is refused — a green here without this fixture would be a green over an edge set that silently includes every plain label a project uses. Both uuid orderings are fixtured deliberately: with only one, the join's `>` canonicalisation decides which SIDE the plain label lands on and half the mutations of this rule pass.
  it('never pairs a module with a plain label on the same issue, on either side of the join', async () => {
    const module = await insertModule('alpha', { id: uuidAt(2) });
    const lower = await insertPlainLabel('bug', uuidAt(1));
    const higher = await insertPlainLabel('chore', uuidAt(3));
    await issueOn([module, lower]);
    await issueOn([module, higher]);

    expect(await mods.observedModuleEdges(project.id)).toEqual([]);
  });

  it('weighs an edge by the issues it rests on, and reports every pair on a three-module issue', async () => {
    const a = await insertModule('alpha');
    const b = await insertModule('beta');
    const c = await insertModule('gamma');
    await issueOn([a, b, c]);
    await issueOn([a, b]);

    const edges = await mods.observedModuleEdges(project.id);
    const ab = edges.find((e) => new Set([e.aLabelId, e.bLabelId]).has(c) === false);
    expect(ab?.issueCount).toBe(2);
    expect(edges).toHaveLength(3);
  });

  it('separates issues anchored on a primary from secondary-only co-occurrence', async () => {
    const a = await insertModule('alpha');
    const b = await insertModule('beta');
    const other = await insertModule('delta');
    await issueOn([a, b]);
    await issueOn([other, a, b]);

    const edges = await mods.observedModuleEdges(project.id);
    const ab = edges.find(
      (e) => new Set([e.aLabelId, e.bLabelId]).has(a) && new Set([e.aLabelId, e.bLabelId]).has(b),
    );
    expect(ab?.issueCount).toBe(2);
    expect(ab?.primaryAnchoredIssueCount).toBe(1);
  });

  it('names the highest issue numbers as the evidence, most recent first', async () => {
    const a = await insertModule('alpha');
    const b = await insertModule('beta');
    const seqs: number[] = [];
    for (let i = 0; i < 7; i++) {
      await issueOn([a, b]);
      seqs.push(seq);
    }

    const edges = await mods.observedModuleEdges(project.id);
    expect(edges[0]?.recentIssueSeqs).toEqual(seqs.slice(-5).reverse());
  });

  // cm:guard the hazard is a FOREIGN label on a LOCAL issue, which `issue_labels` permits (its FKs constrain neither side's project) — a fixture whose two projects share no issue cannot fail the project scope at all, and again both uuid orderings are needed to reach both sides of the join
  it('never joins another project module through a shared issue, on either side of the join', async () => {
    const otherProject = await createTestProject(harness.db, user.id);
    const mine = await insertModule('alpha', { id: uuidAt(2) });
    const theirLower = await insertModule('beta', {
      projectId: otherProject.id,
      id: uuidAt(1),
    });
    const theirHigher = await insertModule('gamma', {
      projectId: otherProject.id,
      id: uuidAt(3),
    });
    await issueOn([mine, theirLower]);
    await issueOn([mine, theirHigher]);

    expect(await mods.observedModuleEdges(project.id)).toEqual([]);
    expect((await drift()).observed.moduleCount).toBe(1);
  });
});

describe('the drift report over real rows (ISS-951)', () => {
  it('calls an undeclared pair drift and a parented pair agreed', async () => {
    const parent = await insertModule('platform');
    const child = await insertModule('platform-web', { parentId: parent });
    const stranger = await insertModule('billing');
    await issueOn([parent, child]);
    await issueOn([child, stranger]);

    const report = await drift();
    expect(report.declaration).toEqual({
      state: 'present',
      source: 'label-hierarchy',
      edgeCount: 1,
    });
    expect(report.agreedEdgeCount).toBe(1);
    expect(report.undeclared).toHaveLength(1);
    expect(report.undeclared[0]?.a.name).toBe('billing');
    expect(report.undeclared[0]?.b.name).toBe('platform-web');
    expect(report.undeclared[0]?.nearestCommonAncestor).toBeNull();
  });

  it('tells a project that declares nothing that nothing is declared', async () => {
    const a = await insertModule('alpha');
    const b = await insertModule('beta');
    await issueOn([a, b]);

    const report = await drift();
    expect(report.declaration.state).toBe('absent');
    expect(report.declaration.edgeCount).toBe(0);
    expect(report.undeclared).toHaveLength(1);
  });

  it('carries the slug and knowledge node each module is mapped through', async () => {
    const a = await insertModule('alpha');
    const b = await insertModule('beta');
    await issueOn([a, b]);

    const report = await drift();
    expect(report.undeclared[0]?.a).toMatchObject({ slug: 'alpha', knowledgeEntryId: null });
    expect(report.layer).toBe('module-taxonomy');
  });
});

describe('GET /api/projects/:id/modules/drift (ISS-951)', () => {
  const req = (path: string, opts: { token?: string } = {}) =>
    app.request(`/api${path}`, {
      headers: { authorization: `Bearer ${opts.token ?? token}` },
    });

  it('answers a member with the report', async () => {
    const a = await insertModule('alpha');
    const b = await insertModule('beta');
    await issueOn([a, b]);
    await issueOn([a, b]);

    const res = await req(`/projects/${project.id}/modules/drift`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { undeclared: unknown[]; minCoOccurrence: number };
    expect(body.minCoOccurrence).toBe(2);
    expect(body.undeclared).toHaveLength(1);
  });

  // cm:guard the status code is part of the contract ISS-951 states: drift is information, so a project sitting on undeclared couplings is still a 200 — an endpoint that signalled through the status code would be read by a gate, and a gate is answered by declaring edges nobody means
  it('stays 200 with findings, and honours the threshold from the query', async () => {
    const a = await insertModule('alpha');
    const b = await insertModule('beta');
    await issueOn([a, b]);

    const withDefault = await req(`/projects/${project.id}/modules/drift`);
    expect(withDefault.status).toBe(200);
    expect(((await withDefault.json()) as { undeclared: unknown[] }).undeclared).toHaveLength(0);

    const lowered = await req(`/projects/${project.id}/modules/drift?minCoOccurrence=1`);
    expect(lowered.status).toBe(200);
    expect(((await lowered.json()) as { undeclared: unknown[] }).undeclared).toHaveLength(1);
  });

  it('refuses a threshold of zero rather than reading every coincidence as a finding', async () => {
    const res = await req(`/projects/${project.id}/modules/drift?minCoOccurrence=0`);
    expect(res.status).toBe(400);
  });

  it('refuses a non-member', async () => {
    const outsider = await createTestUser(harness.db);
    const outsiderToken = await mods.signUserToken(outsider.id);
    const res = await req(`/projects/${project.id}/modules/drift`, { token: outsiderToken });
    expect(res.status).toBe(403);
  });
});
