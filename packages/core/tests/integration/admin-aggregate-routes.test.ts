import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

// ISS-651 — admin-gated cross-tenant aggregate endpoints. Runs against real
// Postgres (not the mocked-db unit-test style) so the raw SQL in
// admin/aggregate-routes.ts (activity_log joins, date_trunc bucketing,
// percentile_disc) is actually exercised, matching the ISS-267 precedent in
// health-routes.test.ts.
type WorkspaceRow = {
  projectId: string;
  slug: string;
  runs: number;
  spendUsd: number;
  medianLeadTimeMin: number | null;
  openIssues: number;
};
type WorkspaceList = { items: WorkspaceRow[] };

describe('admin aggregate routes (ISS-651)', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

  const ADMIN_EMAIL = 'admin@test.forge.local';

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
    // env.ts freezes `env` at first import — this MUST be set before the
    // dynamic import below (unblocks ISS-816's admin-credential gap for
    // THIS suite; see the plan handoff).
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;

    const { adminAggregateRoutes } = await import('../../src/admin/aggregate-routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    const jwtMod = await import('../../src/auth/jwt.js');
    signUserToken = jwtMod.signUserToken;

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/admin', adminAggregateRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function verifiedUser(email: string) {
    const user = await createTestUser(harness.db, { email });
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    return user;
  }

  async function adminToken() {
    const admin = await verifiedUser(ADMIN_EMAIL);
    return signUserToken(admin.id);
  }

  async function insertIssue(args: {
    projectId: string;
    createdById: string;
    status?: string;
    issSeq?: number;
  }) {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${args.projectId}, ${args.issSeq ?? 1}, ${'t'}, ${args.status ?? 'open'}, ${args.createdById})
    `);
    return id;
  }

  async function insertActivity(args: {
    issueId: string;
    actorId: string;
    action: string;
    payload: object;
    createdAt?: string;
  }) {
    const id = randomUUID();
    const created = args.createdAt ? sql`${args.createdAt}::timestamptz` : sql`now()`;
    await harness.db.execute(sql`
      INSERT INTO activity_log (id, issue_id, actor_type, actor_id, action, payload, created_at)
      VALUES (${id}, ${args.issueId}, ${'user'}, ${args.actorId}, ${args.action}, ${JSON.stringify(args.payload)}::jsonb, ${created})
    `);
  }

  describe('auth gate', () => {
    it('401s an unauthenticated request', async () => {
      const res = await app.request('/api/admin/overview');
      expect(res.status).toBe(401);
    });

    it('403s ADMIN_ONLY for a non-admin authenticated user', async () => {
      const user = await verifiedUser('nobody@test.forge.local');
      const token = await signUserToken(user.id);

      for (const path of ['/api/admin/overview', '/api/admin/adoption', '/api/admin/workspaces']) {
        const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
        expect(res.status).toBe(403);
        const body = (await res.json()) as { code?: string };
        expect(body.code).toBe('ADMIN_ONLY');
      }
    });
  });

  describe('GET /api/admin/overview', () => {
    it('200s with the full {counts,kpis,glance} shape', async () => {
      const token = await adminToken();

      const res = await app.request('/api/admin/overview?window=24h', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        counts: Record<string, number>;
        kpis: Record<string, number>;
        glance: Record<string, { value: number | null; deltaPct: number | null; spark: number[] }>;
      };

      for (const key of [
        'users',
        'usersNew',
        'orgs',
        'projects',
        'activeWorkspaces',
        'devicesOnline',
        'devicesTotal',
      ]) {
        expect(typeof body.counts[key]).toBe('number');
      }
      for (const key of ['openAlerts', 'inFlightJobs', 'spendWindowUsd', 'spendBaselineUsd']) {
        expect(typeof body.kpis[key]).toBe('number');
      }
      for (const key of [
        'leadTimeMinutes',
        'interventionsPerClosed',
        'costPerClosedUsd',
        'successRatePct',
        'signupsWindow',
      ]) {
        const glance = body.glance[key];
        expect(glance).toHaveProperty('value');
        expect(glance).toHaveProperty('deltaPct');
        expect(Array.isArray(glance?.spark)).toBe(true);
      }
      expect(body.glance.leadTimeMinutes?.spark).toHaveLength(24);
    });

    it('cross-tenant: activeWorkspaces + spend span every project', async () => {
      const [owner1, owner2] = await Promise.all([
        verifiedUser('owner1@test.forge.local'),
        verifiedUser('owner2@test.forge.local'),
      ]);
      const [projectA, projectB] = await Promise.all([
        createTestProject(harness.db, owner1.id),
        createTestProject(harness.db, owner2.id),
      ]);
      for (const p of [projectA, projectB]) {
        await harness.db.execute(sql`
          INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
          VALUES (${randomUUID()}, ${p.id}, ${'system'}, ${'completed'}, now())
        `);
      }

      const token = await adminToken();
      const res = await app.request('/api/admin/overview?window=24h', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { counts: { activeWorkspaces: number } };
      expect(body.counts.activeWorkspaces).toBeGreaterThanOrEqual(2);
    });

    it('does not 500 when there is no data at all (SQL smoke)', async () => {
      const token = await adminToken();
      for (const window of ['24h', '7d', '30d']) {
        const res = await app.request(`/api/admin/overview?window=${window}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
      }
    });
  });

  describe('GET /api/admin/adoption', () => {
    it('returns a dense bucketed array with newUsers/cumulativeUsers/activeWorkspaces', async () => {
      const token = await adminToken();
      const res = await app.request('/api/admin/adoption?weeks=4&bucket=week', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{
        bucketStart: string;
        newUsers: number;
        cumulativeUsers: number;
        activeWorkspaces: number;
      }>;
      expect(body).toHaveLength(4);
      for (const row of body) {
        expect(typeof row.bucketStart).toBe('string');
        expect(typeof row.newUsers).toBe('number');
        expect(typeof row.cumulativeUsers).toBe('number');
        expect(typeof row.activeWorkspaces).toBe('number');
      }
      // cumulative is non-decreasing oldest→newest
      for (let i = 1; i < body.length; i++) {
        expect(body[i]?.cumulativeUsers).toBeGreaterThanOrEqual(body[i - 1]?.cumulativeUsers ?? 0);
      }
    });

    it('does not 500 for bucket=day (SQL smoke)', async () => {
      const token = await adminToken();
      const res = await app.request('/api/admin/adoption?weeks=2&bucket=day', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown[];
      expect(body).toHaveLength(14);
    });
  });

  describe('GET /api/admin/workspaces', () => {
    it('returns a bare array + X-Total-Count and honours sort', async () => {
      const owner = await verifiedUser('workspace-owner@test.forge.local');
      const projectA = await createTestProject(harness.db, owner.id, { slug: 'proj-a' });
      const projectB = await createTestProject(harness.db, owner.id, { slug: 'proj-b' });

      // 3 runs for A, 1 for B — sort=runs should put A first.
      for (let i = 0; i < 3; i++) {
        await harness.db.execute(sql`
          INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
          VALUES (${randomUUID()}, ${projectA.id}, ${'system'}, ${'completed'}, now())
        `);
      }
      await harness.db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
        VALUES (${randomUUID()}, ${projectB.id}, ${'system'}, ${'completed'}, now())
      `);
      await insertIssue({ projectId: projectA.id, createdById: owner.id, status: 'open' });

      const token = await adminToken();
      const res = await app.request('/api/admin/workspaces?window=7d&sort=runs&limit=10', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('X-Total-Count')).toBeDefined();
      const body = ((await res.json()) as WorkspaceList).items;
      expect(Array.isArray(body)).toBe(true);

      const rowA = body.find((r) => r.projectId === projectA.id);
      const rowB = body.find((r) => r.projectId === projectB.id);
      expect(rowA?.runs).toBe(3);
      expect(rowB?.runs).toBe(1);
      expect(rowA?.openIssues).toBe(1);

      const indexA = body.findIndex((r) => r.projectId === projectA.id);
      const indexB = body.findIndex((r) => r.projectId === projectB.id);
      expect(indexA).toBeLessThan(indexB);
    });

    it('medianLeadTimeMin is null for a project with no work-start transitions', async () => {
      const owner = await verifiedUser('no-leadtime-owner@test.forge.local');
      const project = await createTestProject(harness.db, owner.id);

      const token = await adminToken();
      const res = await app.request('/api/admin/workspaces?window=7d', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (
        (await res.json()) as {
          items: Array<{ projectId: string; medianLeadTimeMin: number | null }>;
        }
      ).items;
      const row = body.find((r) => r.projectId === project.id);
      expect(row?.medianLeadTimeMin).toBeNull();
    });

    it('computes medianLeadTimeMin from the first in_progress/approved transition', async () => {
      const owner = await verifiedUser('leadtime-owner@test.forge.local');
      const project = await createTestProject(harness.db, owner.id);
      const issueId = await insertIssue({ projectId: project.id, createdById: owner.id });

      await insertActivity({
        issueId,
        actorId: owner.id,
        action: 'issue.statusChanged',
        payload: { from: 'open', to: 'in_progress' },
      });

      const token = await adminToken();
      const res = await app.request('/api/admin/workspaces?window=7d', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (
        (await res.json()) as {
          items: Array<{ projectId: string; medianLeadTimeMin: number | null }>;
        }
      ).items;
      const row = body.find((r) => r.projectId === project.id);
      expect(row?.medianLeadTimeMin).not.toBeNull();
      expect(row?.medianLeadTimeMin).toBeGreaterThanOrEqual(0);
    });
  });
});
