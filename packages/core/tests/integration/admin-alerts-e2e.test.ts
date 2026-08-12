/**
 * ISS-652 — GET /api/admin/alerts against real Postgres (own requireAdmin
 * router, same pattern as ISS-651's admin-aggregate-routes.test.ts) so the
 * raw SQL in alert-queries.ts (window functions, quarantine exclusion,
 * terminal-run join) is actually exercised.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  type TestDatabase,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('admin alert routes (ISS-652)', () => {
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
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;

    const { adminAlertRoutes } = await import('../../src/admin/alert-routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    const jwtMod = await import('../../src/auth/jwt.js');
    signUserToken = jwtMod.signUserToken;

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/admin', adminAlertRoutes);
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

  async function insertRun(projectId: string, status: string): Promise<string> {
    const id = randomUUID();
    const finishedAt =
      status === 'running' || status === 'paused' ? null : new Date().toISOString();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at)
      VALUES (${id}, ${projectId}, 'system', ${status}, now(), ${finishedAt})
    `);
    return id;
  }

  async function insertJob(args: {
    projectId: string;
    runId: string;
    status: string;
    dispatchedAgoMinutes?: number;
    queuedAgoMinutes?: number;
  }): Promise<string> {
    const id = randomUUID();
    const dispatchedAt =
      args.dispatchedAgoMinutes === undefined
        ? null
        : new Date(Date.now() - args.dispatchedAgoMinutes * 60_000).toISOString();
    const queuedAt =
      args.queuedAgoMinutes === undefined
        ? new Date().toISOString()
        : new Date(Date.now() - args.queuedAgoMinutes * 60_000).toISOString();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, type, status, payload, pipeline_run_id, created_by, queued_at, dispatched_at)
      VALUES (
        ${id}, ${args.projectId}, 'code', ${args.status}, '{}'::jsonb, ${args.runId},
        (SELECT created_by FROM projects WHERE id = ${args.projectId}), ${queuedAt}, ${dispatchedAt}
      )
    `);
    return id;
  }

  async function insertRunner(args: {
    projectId: string;
    status: string;
    quarantinedUntil?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, host, name, status, quarantined_until)
      VALUES (${id}, ${args.projectId}, 'claude-code', 'remote', 'test-runner', ${args.status}, ${args.quarantinedUntil ?? null})
    `);
    return id;
  }

  describe('auth gate', () => {
    it('401s an unauthenticated request', async () => {
      const res = await app.request('/api/admin/alerts');
      expect(res.status).toBe(401);
    });

    it('403s ADMIN_ONLY for a non-admin authenticated user', async () => {
      const user = await verifiedUser('nobody@test.forge.local');
      const token = await signUserToken(user.id);
      const res = await app.request('/api/admin/alerts', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe('ADMIN_ONLY');
    });
  });

  describe('GET /api/admin/alerts', () => {
    it('200s with exactly 5 items A1-A5, all ok, on healthy data', async () => {
      const token = await adminToken();
      const res = await app.request('/api/admin/alerts', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('X-Total-Count')).toBe('5');
      const body = (await res.json()) as Array<{ id: string; status: string; count: number }>;
      expect(body.map((a) => a.id)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
      for (const alert of body) expect(alert.status).toBe('ok');
      expect(body[0]?.count).toBe(0);
    });

    it('A2 catches BOTH dispatched and running past staleSeconds (AC 5)', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      const run = await insertRun(project.id, 'running');
      await insertJob({
        projectId: project.id,
        runId: run,
        status: 'dispatched',
        dispatchedAgoMinutes: 20,
      });
      await insertJob({
        projectId: project.id,
        runId: run,
        status: 'dispatched',
        dispatchedAgoMinutes: 20,
      });
      await insertJob({
        projectId: project.id,
        runId: run,
        status: 'running',
        dispatchedAgoMinutes: 20,
      });

      const token = await adminToken();
      const res = await app.request('/api/admin/alerts?staleSeconds=600', {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as Array<{ id: string; status: string; count: number }>;
      const a2 = body.find((a) => a.id === 'A2');
      expect(a2?.count).toBe(3);
      expect(a2?.status).not.toBe('ok');

      const clearRes = await app.request('/api/admin/alerts?staleSeconds=86400', {
        headers: { authorization: `Bearer ${token}` },
      });
      const clearBody = (await clearRes.json()) as Array<{ id: string; status: string }>;
      expect(clearBody.find((a) => a.id === 'A2')?.status).toBe('ok');
    });

    it('A3 fires only when the only runner is quarantined, not just non-online (AC 7)', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      const run = await insertRun(project.id, 'running');
      await insertJob({
        projectId: project.id,
        runId: run,
        status: 'queued',
        queuedAgoMinutes: 10,
      });
      const runnerId = await insertRunner({
        projectId: project.id,
        status: 'online',
        quarantinedUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
      });

      const token = await adminToken();
      const res = await app.request('/api/admin/alerts', {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as Array<{ id: string; status: string; count: number }>;
      const a3 = body.find((a) => a.id === 'A3');
      expect(a3?.status).not.toBe('ok');
      expect(a3?.count).toBeGreaterThanOrEqual(1);

      await harness.db.execute(
        sql`UPDATE runners SET quarantined_until = NULL WHERE id = ${runnerId}`,
      );
      const clearRes = await app.request('/api/admin/alerts', {
        headers: { authorization: `Bearer ${token}` },
      });
      const clearBody = (await clearRes.json()) as Array<{ id: string; status: string }>;
      expect(clearBody.find((a) => a.id === 'A3')?.status).toBe('ok');
    });

    it('A1 is crit for a job orphaned under a terminal pipeline_run', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      const run = await insertRun(project.id, 'cancelled');

      // cm:why ISS-448's I1 trigger auto-cancels any active child written under a terminal run; disable it to simulate a pre-existing orphan, same as i1-orphan-trigger.test.ts's backfill case
      await harness.db.execute(
        sql`ALTER TABLE jobs DISABLE TRIGGER trg_jobs_no_active_under_terminal_run`,
      );
      await insertJob({ projectId: project.id, runId: run, status: 'queued' });
      await harness.db.execute(
        sql`ALTER TABLE jobs ENABLE TRIGGER trg_jobs_no_active_under_terminal_run`,
      );

      const token = await adminToken();
      const res = await app.request('/api/admin/alerts', {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as Array<{ id: string; status: string; count: number }>;
      const a1 = body.find((a) => a.id === 'A1');
      expect(a1?.status).toBe('crit');
      expect(a1?.count).toBe(1);
    });
  });
});
