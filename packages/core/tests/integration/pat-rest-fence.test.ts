import { randomUUID } from 'node:crypto';
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

/**
 * The PAT fence on the REST data plane, against the whole mounted app.
 *
 * Two halves, and they defend different things. The sweep walks every route
 * Hono has registered and proves a scoped PAT reaches nothing outside
 * `PAT_ALLOWED_PREFIXES` — that is what makes the allowlist trustworthy
 * without reading 73 route modules, and it is what fails when someone mounts
 * a new router later. The fence cases prove that inside the allowlist a token
 * bound to project A cannot see project B, including where the project is
 * resolved indirectly from an issue id the caller supplies.
 */

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

describe('PAT fence on the REST data plane', () => {
  let harness: TestDatabase;
  let app: Hono<AppVars>;
  let projectA: string;
  let projectB: string;
  let projectArchived: string;
  let issueA: string;
  let issueB: string;
  let boundToA: string;
  let listScopedToA: string;
  let unscoped: string;
  let readOnlyBoundToA: string;
  let patAllowedFor: (path: string) => boolean;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV = 'test';

    await truncateAll(harness.db);

    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const org = await seedOrg(harness.db, user.id);

    const a = await createTestProject(harness.db, user.id, { orgId: org.id });
    const b = await createTestProject(harness.db, user.id, { orgId: org.id });
    projectA = a.id;
    projectB = b.id;
    await createTestProjectMember(harness.db, { projectId: projectA, userId: user.id });
    await createTestProjectMember(harness.db, { projectId: projectB, userId: user.id });

    const archived = await createTestProject(harness.db, user.id, { orgId: org.id });
    projectArchived = archived.id;
    await createTestProjectMember(harness.db, { projectId: projectArchived, userId: user.id });
    await harness.db.execute(
      sql`UPDATE projects SET archived_at = now() WHERE id = ${projectArchived}`,
    );

    issueA = await seedIssue(projectA, user.id);
    issueB = await seedIssue(projectB, user.id);

    const { mintPat } = await import('../../src/auth/pat.js');
    boundToA = (await mintPat({ userId: user.id, name: 'bound-a', boundProjectId: projectA }))
      .plaintext;
    listScopedToA = (await mintPat({ userId: user.id, name: 'list-a', projectIds: [projectA] }))
      .plaintext;
    unscoped = (await mintPat({ userId: user.id, name: 'unscoped' })).plaintext;
    readOnlyBoundToA = (
      await mintPat({
        userId: user.id,
        name: 'ro-a',
        boundProjectId: projectA,
        scopes: ['read'],
      })
    ).plaintext;

    ({ app } = await import('../../src/index.js'));
    ({ patAllowedFor } = await import('../../src/middleware/pat-rest-surface.js'));
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  async function seedIssue(projectId: string, createdBy: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, created_by_id)
      VALUES (${id}, ${projectId}, 'fence probe', 'open', ${createdBy})
    `);
    return id;
  }

  function get(path: string, token?: string) {
    return app.request(path, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  it('a token bound to A cannot read project B', async () => {
    expect((await get(`/api/projects/${projectA}`, boundToA)).status).toBe(200);
    expect((await get(`/api/projects/${projectB}`, boundToA)).status).toBe(404);
  });

  // cm:guard the INDIRECT case, and it is the one a URL-param middleware would have missed — nothing in this path names a project, the route resolves it from the issue row, and the fence only fires because it sits in `effectiveProjectRole` rather than in a middleware reading `:projectId`. Rewrite the fence anywhere higher and this is the test that goes red.
  it('a token bound to A cannot read an issue that lives in B', async () => {
    expect((await get(`/api/issues/${issueA}`, boundToA)).status).toBe(200);
    expect((await get(`/api/issues/${issueB}`, boundToA)).status).toBe(404);
  });

  it('an allowlist token (projectIds, no binding) is fenced the same way', async () => {
    expect((await get(`/api/projects/${projectA}`, listScopedToA)).status).toBe(200);
    expect((await get(`/api/projects/${projectB}`, listScopedToA)).status).toBe(404);
  });

  it('a user-level token stays unfenced', async () => {
    expect((await get(`/api/projects/${projectA}`, unscoped)).status).toBe(200);
    expect((await get(`/api/projects/${projectB}`, unscoped)).status).toBe(200);
  });

  // cm:guard the list endpoints are the half `effectiveProjectRole` cannot defend — they name no project, so the per-project gate never fires and only the `loadVisibleProjectIds` intersection stands between a scoped token and every project id its owner can see
  it('the project list returns only the fenced project', async () => {
    const body = (await (await get('/api/projects', boundToA)).json()) as
      | { projects?: Array<{ id: string }> }
      | Array<{ id: string }>;
    const rows = Array.isArray(body) ? body : (body.projects ?? []);
    const ids = rows.map((p) => p.id);
    expect(ids).toContain(projectA);
    expect(ids).not.toContain(projectB);
  });

  // cm:guard this case is here, in the fence file, because it defends the SAME predicate: `visibleProjectsWhere` carries both the archived filter and the fence as sibling conditions, so the unparenthesised `OR` that annulled one would have annulled the other. Nothing else in the suite asserts the list excludes an archived project, which is how that shape survived to 2026-09-01.
  it('the project list still excludes an archived project the caller is a member of', async () => {
    const body = (await (await get('/api/projects', unscoped)).json()) as
      | { projects?: Array<{ id: string }> }
      | Array<{ id: string }>;
    const rows = Array.isArray(body) ? body : (body.projects ?? []);
    expect(rows.map((p) => p.id)).not.toContain(projectArchived);
  });

  // cm:guard named explicitly rather than left to the sweep: a scoped token that can mint an unscoped one has no scope, so this is the single refusal whose absence collapses every other assertion in this file
  it('no PAT can reach the PAT-minting surface', async () => {
    for (const token of [boundToA, unscoped]) {
      const res = await get('/api/pat', token);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe('PAT_NOT_PERMITTED');
    }
  });

  it('a read-scoped token cannot write', async () => {
    const res = await app.request(`/api/projects/${projectA}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${readOnlyBoundToA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed by a read-only token' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('INSUFFICIENT_SCOPE');
  });

  /**
   * The sweep. Every GET route the app has registered outside the allowlist
   * must refuse a PAT — unless the route is public, which is decided by
   * asking it the same question with no credential at all rather than by a
   * hand-kept exemption list that would drift.
   */
  it('no registered route outside the allowlist answers a PAT', async () => {
    const paths = new Set<string>();
    for (const route of app.routes) {
      if (route.method !== 'GET' && route.method !== 'ALL') continue;
      if (!route.path.startsWith('/api/')) continue;
      if (route.path.includes('*')) continue;
      if (patAllowedFor(route.path)) continue;
      paths.add(
        route.path.replace(/:[A-Za-z0-9_]+/g, (m) =>
          /project/i.test(m) ? projectB : '00000000-0000-4000-8000-000000000000',
        ),
      );
    }
    expect(paths.size).toBeGreaterThan(15);

    const reachable: string[] = [];
    for (const path of paths) {
      const withPat = await get(path, boundToA);
      if (withPat.status < 200 || withPat.status >= 300) continue;
      const anonymous = await get(path);
      if (anonymous.status >= 200 && anonymous.status < 300) continue;
      reachable.push(`${path} → ${withPat.status}`);
    }

    expect(
      reachable,
      'these routes answered a project-scoped PAT and are NOT on PAT_ALLOWED_PREFIXES. Either ' +
        'the route resolves a project and belongs on the allowlist, or it does not — in which ' +
        'case a PAT there is an account-scoped credential wearing a project-scoped label, and ' +
        'the fence in lib/authz.ts has nothing to bite on.',
    ).toEqual([]);
  });
});
