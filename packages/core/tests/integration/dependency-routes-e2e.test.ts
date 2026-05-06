/**
 * ISS-40 PR-E — issue dependency HTTP routes integration tests.
 *
 * Drives the Hono routes from `src/issues/dependency-routes.ts` against a
 * real Postgres + JWT auth, including:
 *   - 201 create / 200 idempotent on duplicate
 *   - 400 self-edge
 *   - 409 cycle (DFS through real DB)
 *   - GET returns outgoing + incoming directions
 *   - DELETE removes the row
 *   - Project membership enforcement
 *   - Cross-project edges rejected via this user-facing route (allowed via
 *     `forge_pm.set_dependency` MCP path — covered separately).
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  issueDependencyRoutes: typeof import('../../src/issues/dependency-routes.js').issueDependencyRoutes;
  signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  errorHandler: typeof import('../../src/middleware/error.js').errorHandler;
};

describe('ISS-40 issue dependency routes E2E', () => {
  let harness: TestDatabase;
  let mods: Mods;
  // biome-ignore lint/suspicious/noExplicitAny: test-only mount
  let app: any;

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

    const [routesMod, jwtMod, errMod] = await Promise.all([
      import('../../src/issues/dependency-routes.js'),
      import('../../src/auth/jwt.js'),
      import('../../src/middleware/error.js'),
    ]);
    mods = {
      issueDependencyRoutes: routesMod.issueDependencyRoutes,
      signUserToken: jwtMod.signUserToken,
      errorHandler: errMod.errorHandler,
    };

    app = new Hono();
    app.route('/api/issues', mods.issueDependencyRoutes);
    app.onError(mods.errorHandler);
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  // ---------- helpers ---------------------------------------------------

  async function seedProjectAndOwner(opts: { verified?: boolean } = {}) {
    const user = await createTestUser(harness.db);
    if (opts.verified !== false) {
      await harness.db.execute(
        sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`,
      );
    }
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'owner',
    });
    return { user, project };
  }

  async function insertIssue(projectId: string, ownerId: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (
        ${id}, ${projectId}, ${Math.floor(Math.random() * 1_000_000)},
        'Issue', 'open', ${ownerId}
      )
    `);
    return id;
  }

  function authHeaders(token: string) {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    };
  }

  // ---------- POST ------------------------------------------------------

  describe('POST /api/issues/:id/dependencies', () => {
    it('201 — creates a new edge', async () => {
      const { user, project } = await seedProjectAndOwner();
      const a = await insertIssue(project.id, user.id);
      const b = await insertIssue(project.id, user.id);
      const token = await mods.signUserToken(user.id);

      const res = await app.request(`/api/issues/${b}/dependencies`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ dependsOnId: a, kind: 'blocks' }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; created: boolean };
      expect(body.created).toBe(true);
      expect(body.id).toMatch(/^[0-9a-f-]{36}$/);

      const rows = await harness.db.execute<{ from_issue_id: string; to_issue_id: string }>(sql`
        SELECT from_issue_id, to_issue_id FROM issue_dependencies WHERE id = ${body.id}
      `);
      expect(rows[0]?.from_issue_id).toBe(a);
      expect(rows[0]?.to_issue_id).toBe(b);
    });

    it('200 — idempotent on duplicate (returns existing row, created:false)', async () => {
      const { user, project } = await seedProjectAndOwner();
      const a = await insertIssue(project.id, user.id);
      const b = await insertIssue(project.id, user.id);
      const token = await mods.signUserToken(user.id);

      const r1 = await app.request(`/api/issues/${b}/dependencies`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ dependsOnId: a }),
      });
      expect(r1.status).toBe(201);
      const body1 = (await r1.json()) as { id: string };

      const r2 = await app.request(`/api/issues/${b}/dependencies`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ dependsOnId: a }),
      });
      expect(r2.status).toBe(200);
      const body2 = (await r2.json()) as { id: string; created: boolean };
      expect(body2.created).toBe(false);
      expect(body2.id).toBe(body1.id);
    });

    it('400 SELF_DEP — self-edge rejected', async () => {
      const { user, project } = await seedProjectAndOwner();
      const a = await insertIssue(project.id, user.id);
      const token = await mods.signUserToken(user.id);
      const res = await app.request(`/api/issues/${a}/dependencies`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ dependsOnId: a }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('SELF_DEP');
    });

    it('409 CYCLE_DETECTED — closing a 2-node cycle is rejected', async () => {
      const { user, project } = await seedProjectAndOwner();
      const a = await insertIssue(project.id, user.id);
      const b = await insertIssue(project.id, user.id);
      const token = await mods.signUserToken(user.id);

      // Create A → B (B depends on A)
      const r1 = await app.request(`/api/issues/${b}/dependencies`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ dependsOnId: a }),
      });
      expect(r1.status).toBe(201);

      // Now try B → A (A depends on B) — would close the cycle.
      const r2 = await app.request(`/api/issues/${a}/dependencies`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ dependsOnId: b }),
      });
      expect(r2.status).toBe(409);
      const body = (await r2.json()) as { code: string };
      expect(body.code).toBe('CYCLE_DETECTED');
    });

    it('409 CYCLE_DETECTED — closing a 3-node cycle (A→B→C, then C→A) is rejected', async () => {
      const { user, project } = await seedProjectAndOwner();
      const a = await insertIssue(project.id, user.id);
      const b = await insertIssue(project.id, user.id);
      const c = await insertIssue(project.id, user.id);
      const token = await mods.signUserToken(user.id);

      // A→B (B depends on A)
      await app.request(`/api/issues/${b}/dependencies`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ dependsOnId: a }),
      });
      // B→C (C depends on B)
      await app.request(`/api/issues/${c}/dependencies`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ dependsOnId: b }),
      });

      // Now C→A (A depends on C) closes the loop A→B→C→A.
      const res = await app.request(`/api/issues/${a}/dependencies`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ dependsOnId: c }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('CYCLE_DETECTED');
    });

    it('400 CROSS_PROJECT — cross-project edge rejected via this route', async () => {
      const a = await seedProjectAndOwner();
      const b = await seedProjectAndOwner();
      // Make user A also a member of project B so auth passes.
      await createTestProjectMember(harness.db, {
        userId: a.user.id,
        projectId: b.project.id,
        role: 'member',
      });
      const issA = await insertIssue(a.project.id, a.user.id);
      const issB = await insertIssue(b.project.id, b.user.id);
      const token = await mods.signUserToken(a.user.id);
      const res = await app.request(`/api/issues/${issB}/dependencies`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ dependsOnId: issA }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('CROSS_PROJECT');
    });

    it('403 — non-member is forbidden', async () => {
      const { user: owner, project } = await seedProjectAndOwner();
      const stranger = await createTestUser(harness.db);
      await harness.db.execute(
        sql`UPDATE users SET email_verified_at = now() WHERE id = ${stranger.id}`,
      );
      const a = await insertIssue(project.id, owner.id);
      const b = await insertIssue(project.id, owner.id);
      const token = await mods.signUserToken(stranger.id);
      const res = await app.request(`/api/issues/${b}/dependencies`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ dependsOnId: a }),
      });
      expect(res.status).toBe(403);
    });

    it('non-`blocks` kinds skip cycle check (relates can be cyclic)', async () => {
      const { user, project } = await seedProjectAndOwner();
      const a = await insertIssue(project.id, user.id);
      const b = await insertIssue(project.id, user.id);
      const token = await mods.signUserToken(user.id);
      // A relates B, then B relates A — both should succeed.
      const r1 = await app.request(`/api/issues/${b}/dependencies`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ dependsOnId: a, kind: 'relates' }),
      });
      expect(r1.status).toBe(201);
      const r2 = await app.request(`/api/issues/${a}/dependencies`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ dependsOnId: b, kind: 'relates' }),
      });
      expect(r2.status).toBe(201);
    });
  });

  // ---------- GET -------------------------------------------------------

  describe('GET /api/issues/:id/dependencies', () => {
    it('returns outgoing + incoming edges for the issue', async () => {
      const { user, project } = await seedProjectAndOwner();
      const a = await insertIssue(project.id, user.id);
      const b = await insertIssue(project.id, user.id);
      const c = await insertIssue(project.id, user.id);
      const token = await mods.signUserToken(user.id);

      // B depends on A (incoming for B): A → B
      await app.request(`/api/issues/${b}/dependencies`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ dependsOnId: a }),
      });
      // C depends on B (outgoing for B): B → C
      await app.request(`/api/issues/${c}/dependencies`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ dependsOnId: b }),
      });

      const res = await app.request(`/api/issues/${b}/dependencies`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        outgoing: Array<{ fromIssueId: string; toIssueId: string }>;
        incoming: Array<{ fromIssueId: string; toIssueId: string }>;
      };
      expect(body.outgoing).toHaveLength(1);
      expect(body.outgoing[0]?.fromIssueId).toBe(b);
      expect(body.outgoing[0]?.toIssueId).toBe(c);
      expect(body.incoming).toHaveLength(1);
      expect(body.incoming[0]?.fromIssueId).toBe(a);
      expect(body.incoming[0]?.toIssueId).toBe(b);
    });

    it('404 when the issue does not exist', async () => {
      const { user } = await seedProjectAndOwner();
      const token = await mods.signUserToken(user.id);
      const res = await app.request(`/api/issues/${randomUUID()}/dependencies`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(404);
    });
  });

  // ---------- DELETE ----------------------------------------------------

  describe('DELETE /api/issues/:id/dependencies/:edgeId', () => {
    it('removes the edge', async () => {
      const { user, project } = await seedProjectAndOwner();
      const a = await insertIssue(project.id, user.id);
      const b = await insertIssue(project.id, user.id);
      const token = await mods.signUserToken(user.id);

      const create = await app.request(`/api/issues/${b}/dependencies`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ dependsOnId: a }),
      });
      const { id: edgeId } = (await create.json()) as { id: string };

      const del = await app.request(`/api/issues/${b}/dependencies/${edgeId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.status).toBe(200);

      const rows = await harness.db.execute<{ count: string }>(sql`
        SELECT COUNT(*)::text AS count FROM issue_dependencies WHERE id = ${edgeId}
      `);
      expect(rows[0]?.count).toBe('0');
    });

    it('400 EDGE_MISMATCH — :id must be one of the edge endpoints', async () => {
      const { user, project } = await seedProjectAndOwner();
      const a = await insertIssue(project.id, user.id);
      const b = await insertIssue(project.id, user.id);
      const c = await insertIssue(project.id, user.id);
      const token = await mods.signUserToken(user.id);

      const create = await app.request(`/api/issues/${b}/dependencies`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ dependsOnId: a }),
      });
      const { id: edgeId } = (await create.json()) as { id: string };

      const del = await app.request(`/api/issues/${c}/dependencies/${edgeId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.status).toBe(400);
      const body = (await del.json()) as { code: string };
      expect(body.code).toBe('EDGE_MISMATCH');
    });

    it('404 when the edge does not exist', async () => {
      const { user, project } = await seedProjectAndOwner();
      const a = await insertIssue(project.id, user.id);
      const token = await mods.signUserToken(user.id);
      const res = await app.request(`/api/issues/${a}/dependencies/${randomUUID()}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(404);
    });
  });
});
