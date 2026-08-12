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
    // cm:why defaults to a fresh heartbeat (now), like a real 'online' runner; override to simulate the A3 staleness/rate-limit contributors
    lastSeenAt?: string | null;
    rateLimitedUntil?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, host, name, status, quarantined_until, last_seen_at, rate_limited_until)
      VALUES (
        ${id}, ${args.projectId}, 'claude-code', 'remote', 'test-runner', ${args.status},
        ${args.quarantinedUntil ?? null},
        ${args.lastSeenAt === undefined ? new Date().toISOString() : args.lastSeenAt},
        ${args.rateLimitedUntil ?? null}
      )
    `);
    return id;
  }

  async function insertBinding(projectId: string): Promise<string> {
    const owner = await createTestUser(harness.db);
    const connectionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider)
      VALUES (${connectionId}, 'user', ${owner.id}, 'coolify')
    `);
    const bindingId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO integration_bindings (id, connection_id, project_id, provider, environment)
      VALUES (${bindingId}, ${connectionId}, ${projectId}, 'coolify', 'prod')
    `);
    return bindingId;
  }

  async function insertDelivery(args: {
    bindingId: string;
    direction: 'outbound' | 'inbound';
    status: 'ok' | 'failed';
    createdAgoMinutes?: number;
  }): Promise<void> {
    const createdAt = new Date(Date.now() - (args.createdAgoMinutes ?? 1) * 60_000).toISOString();
    await harness.db.execute(sql`
      INSERT INTO integration_deliveries (id, binding_id, direction, event_name, status, created_at)
      VALUES (${randomUUID()}, ${args.bindingId}, ${args.direction}, 'deploy', ${args.status}, ${createdAt})
    `);
  }

  async function insertUsage(args: {
    projectId: string | null;
    cost: number;
    recordedAgoHours: number;
  }): Promise<void> {
    const id = randomUUID();
    const recordedAt = new Date(Date.now() - args.recordedAgoHours * 3_600_000).toISOString();
    await harness.db.execute(sql`
      INSERT INTO usage_records (id, project_id, source, model, estimated_cost, recorded_at)
      VALUES (${id}, ${args.projectId}, 'api', 'test-model', ${args.cost}, ${recordedAt})
    `);
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

    // cm:guard regression guard for the review fix: A3's "usable runner" must mirror
    // the actual dispatch gate — online + unquarantined is NOT sufficient on its own.
    it('A3 fires when the only runner is online but its heartbeat is stale', async () => {
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
        lastSeenAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      });

      const token = await adminToken();
      const res = await app.request('/api/admin/alerts', {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as Array<{ id: string; status: string; count: number }>;
      expect(body.find((a) => a.id === 'A3')?.status).not.toBe('ok');

      await harness.db.execute(sql`UPDATE runners SET last_seen_at = now() WHERE id = ${runnerId}`);
      const clearRes = await app.request('/api/admin/alerts', {
        headers: { authorization: `Bearer ${token}` },
      });
      const clearBody = (await clearRes.json()) as Array<{ id: string; status: string }>;
      expect(clearBody.find((a) => a.id === 'A3')?.status).toBe('ok');
    });

    it('A3 fires when the only runner is online and fresh but rate-limited', async () => {
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
        rateLimitedUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
      });

      const token = await adminToken();
      const res = await app.request('/api/admin/alerts', {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as Array<{ id: string; status: string; count: number }>;
      expect(body.find((a) => a.id === 'A3')?.status).not.toBe('ok');

      await harness.db.execute(
        sql`UPDATE runners SET rate_limited_until = NULL WHERE id = ${runnerId}`,
      );
      const clearRes = await app.request('/api/admin/alerts', {
        headers: { authorization: `Bearer ${token}` },
      });
      const clearBody = (await clearRes.json()) as Array<{ id: string; status: string }>;
      expect(clearBody.find((a) => a.id === 'A3')?.status).toBe('ok');
    });

    it('A4 fires crit for a project whose current-window spend ratio clears the crit threshold', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      await insertUsage({ projectId: project.id, cost: 20, recordedAgoHours: 0.5 });
      await insertUsage({ projectId: project.id, cost: 2, recordedAgoHours: 1.5 });

      const token = await adminToken();
      const res = await app.request('/api/admin/alerts', {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as Array<{ id: string; status: string; count: number }>;
      const a4 = body.find((a) => a.id === 'A4');
      expect(a4?.status).toBe('crit');
      expect(a4?.count).toBeGreaterThanOrEqual(1);
    });

    // cm:guard regression guard for the plan-review fix: a global-only fire (no single project individually crosses the ratio — e.g. project_id-less system usage) must still report count >= 1, never 0, or a consumer filtering on count > 0 silently drops a live spend spike
    it('A4 count stays >= 1 on a global-only fire with no per-project contributor', async () => {
      await insertUsage({ projectId: null, cost: 20, recordedAgoHours: 0.5 });

      const token = await adminToken();
      const res = await app.request('/api/admin/alerts', {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as Array<{
        id: string;
        status: string;
        count: number;
        entities: unknown[];
      }>;
      const a4 = body.find((a) => a.id === 'A4');
      expect(a4?.status).not.toBe('ok');
      expect(a4?.entities).toHaveLength(0);
      expect(a4?.count).toBeGreaterThanOrEqual(1);
    });

    // cm:guard inbound webhook deliveries (recorded 'ok' by Coolify even on a reported deploy failure) must not dilute a real outbound delivery fail-rate
    it('A5 fires on an outbound fail-rate even when inbound deliveries are all ok', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      const bindingId = await insertBinding(project.id);

      for (let i = 0; i < 5; i++) {
        await insertDelivery({ bindingId, direction: 'inbound', status: 'ok' });
      }
      for (let i = 0; i < 4; i++) {
        await insertDelivery({ bindingId, direction: 'outbound', status: 'failed' });
      }
      await insertDelivery({ bindingId, direction: 'outbound', status: 'ok' });

      const token = await adminToken();
      const res = await app.request('/api/admin/alerts', {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as Array<{ id: string; status: string; count: number }>;
      const a5 = body.find((a) => a.id === 'A5');
      expect(a5?.status).not.toBe('ok');
      expect(a5?.count).toBeGreaterThanOrEqual(1);
    });

    it('A5 stays ok when only inbound deliveries are failing', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      const bindingId = await insertBinding(project.id);

      for (let i = 0; i < 5; i++) {
        await insertDelivery({ bindingId, direction: 'inbound', status: 'failed' });
      }
      for (let i = 0; i < 5; i++) {
        await insertDelivery({ bindingId, direction: 'outbound', status: 'ok' });
      }

      const token = await adminToken();
      const res = await app.request('/api/admin/alerts', {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as Array<{ id: string; status: string }>;
      expect(body.find((a) => a.id === 'A5')?.status).toBe('ok');
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
