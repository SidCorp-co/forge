/**
 * A runner must never keep reporting a fault it has outlived (`VISION: state-never-lies`).
 *
 * Two writers set `runners.last_error` without a limit — `attributeFailureToRunner`
 * (preflight) and the dispatcher's adapter-failure path — and nothing cleared it:
 * on forge-dev, `dev1 · cx` still read `preflight_failed: push_credentials` 24
 * minutes after its next review job passed, and two more boxes quoted a spend cap
 * whose window had already closed. Both halves of the clear are pure SQL /
 * conditional UPDATE, so they need a real database to mean anything.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  type TestUser,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  clearRunnerLimit: typeof import('../../src/runners/apply-runner-limit.js').clearRunnerLimit;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  mirrorHeartbeatToRunners: typeof import('../../src/devices/heartbeat-runner-mirror.js').mirrorHeartbeatToRunners;
};

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

const SPEND_CAP =
  "[RESULT_ERROR] success: You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit";
const PREFLIGHT = 'preflight_failed: push_credentials: ls-remote timed out after 20s';

interface HealthRow {
  last_error: string | null;
  limit_reason: string | null;
  limit_detail: string | null;
  rate_limited_until: string | null;
  updated_at: string;
}

describe('runner fault flags clear when the fault is over', () => {
  let harness: TestDatabase;
  let mods: Mods;
  let app: Hono<AppVars>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

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

    const limitMod = await import('../../src/runners/apply-runner-limit.js');
    const mirrorMod = await import('../../src/devices/heartbeat-runner-mirror.js');
    mods = {
      clearRunnerLimit: limitMod.clearRunnerLimit,
      mirrorHeartbeatToRunners: mirrorMod.mirrorHeartbeatToRunners,
    };

    const { projectRoutes } = await import('../../src/projects/routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;
    app = new Hono<AppVars>();
    app.use('*', requestId());
    app.route('/api/projects', projectRoutes);
    app.onError(errorHandler);
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seedRunner(health: {
    lastError?: string | null;
    limitReason?: 'usage_limit' | 'rate_limit' | 'auth' | null;
    limitDetail?: string | null;
    rateLimitedUntil?: Date | null;
  }) {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const device = await createTestDevice(harness.db, owner.id);
    const runnerId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, name, type, host, status, last_seen_at,
                           last_error, limit_reason, limit_detail, rate_limited_until)
      VALUES (${runnerId}, ${project.id}, ${device.id}, 'box', 'claude-code', 'device', 'online', now(),
              ${health.lastError ?? null}, ${health.limitReason ?? null},
              ${health.limitDetail ?? null}, ${health.rateLimitedUntil?.toISOString() ?? null})
    `);
    return { runnerId, projectId: project.id, deviceId: device.id };
  }

  async function healthOf(runnerId: string): Promise<HealthRow> {
    const rows = (await harness.db.execute(sql`
      SELECT last_error, limit_reason, limit_detail, rate_limited_until, updated_at
      FROM runners WHERE id = ${runnerId}
    `)) as unknown as HealthRow[];
    return rows[0] as HealthRow;
  }

  describe('on a successful job (clearRunnerLimit)', () => {
    // cm:guard the whole bug in one assertion — a box-scoped lastError carries NO limitReason, so a limit-only guard left it pinned through every later success
    it('clears a lastError that was never accompanied by a limit', async () => {
      const s = await seedRunner({ lastError: PREFLIGHT });
      await mods.clearRunnerLimit(s.runnerId, s.projectId);
      expect((await healthOf(s.runnerId)).last_error).toBeNull();
    });

    it('clears a stamped limit together with its mirrored lastError', async () => {
      const s = await seedRunner({
        lastError: SPEND_CAP,
        limitReason: 'usage_limit',
        limitDetail: SPEND_CAP,
        rateLimitedUntil: new Date(Date.now() + 6 * 60 * 60 * 1000),
      });
      await mods.clearRunnerLimit(s.runnerId, s.projectId);
      const h = await healthOf(s.runnerId);
      expect(h.last_error).toBeNull();
      expect(h.limit_reason).toBeNull();
      expect(h.limit_detail).toBeNull();
      expect(h.rate_limited_until).toBeNull();
    });

    it('stays a no-op write on an already-healthy runner', async () => {
      const s = await seedRunner({});
      const before = await healthOf(s.runnerId);
      await mods.clearRunnerLimit(s.runnerId, s.projectId);
      const after = await healthOf(s.runnerId);
      expect(after.updated_at).toBe(before.updated_at);
    });

    it('does not reach across runners', async () => {
      const faulted = await seedRunner({ lastError: PREFLIGHT });
      const other = await seedRunner({ lastError: PREFLIGHT });
      await mods.clearRunnerLimit(faulted.runnerId, faulted.projectId);
      expect((await healthOf(faulted.runnerId)).last_error).toBeNull();
      expect((await healthOf(other.runnerId)).last_error).toBe(PREFLIGHT);
    });
  });

  describe('on a device heartbeat (mirrorHeartbeatToRunners)', () => {
    it('drops an expired limit and the lastError mirroring it', async () => {
      const s = await seedRunner({
        lastError: SPEND_CAP,
        limitReason: 'usage_limit',
        limitDetail: SPEND_CAP,
        rateLimitedUntil: new Date(Date.now() - 60_000),
      });
      await mods.mirrorHeartbeatToRunners(s.deviceId);
      const h = await healthOf(s.runnerId);
      expect(h.limit_reason).toBeNull();
      expect(h.rate_limited_until).toBeNull();
      expect(h.limit_detail).toBeNull();
      expect(h.last_error).toBeNull();
    });

    // cm:guard this assertion is INVERTED from what it once said, on purpose — it used to demand that a heartbeat DROP the auth limit, which is the bug that let device dev1-ai013 burn 421 jobs in 5.5h (forge-beta 2026-08-14): the stamp was erased ~30s after every failure, so no dispatch gate ever saw it. A heartbeat proves the daemon is alive, never that its OAuth session is valid.
    it('KEEPS an auth limit — a heartbeat is not evidence the credentials were fixed', async () => {
      const s = await seedRunner({
        lastError: 'API Error: 401 invalid authentication credentials',
        limitReason: 'auth',
        limitDetail: 'API Error: 401 invalid authentication credentials',
      });
      await mods.mirrorHeartbeatToRunners(s.deviceId);
      const h = await healthOf(s.runnerId);
      expect(h.limit_reason).toBe('auth');
      expect(h.last_error).toBe('API Error: 401 invalid authentication credentials');
    });

    // cm:guard `retire` writes `disabled` and this UPDATE reverted it inside one beat (measured 2026-08-14: retired 08:19:29, back online 08:19:59), which left no MCP-reachable way to take a bad runner out of the pool
    it('leaves a disabled runner disabled instead of forcing it back online', async () => {
      const s = await seedRunner({});
      await harness.db.execute(
        sql`UPDATE runners SET status = 'disabled' WHERE id = ${s.runnerId}`,
      );

      const transitions = await mods.mirrorHeartbeatToRunners(s.deviceId);

      const rows = (await harness.db.execute(
        sql`SELECT status FROM runners WHERE id = ${s.runnerId}`,
      )) as unknown as { status: string }[];
      expect(rows[0]?.status).toBe('disabled');
      expect(transitions.map((t) => t.id)).not.toContain(s.runnerId);
    });

    it('leaves an unexpired throttle and its mirror in place', async () => {
      const until = new Date(Date.now() + 60 * 60 * 1000);
      const s = await seedRunner({
        lastError: SPEND_CAP,
        limitReason: 'usage_limit',
        limitDetail: SPEND_CAP,
        rateLimitedUntil: until,
      });
      await mods.mirrorHeartbeatToRunners(s.deviceId);
      const h = await healthOf(s.runnerId);
      expect(h.limit_reason).toBe('usage_limit');
      expect(new Date(h.rate_limited_until as string).getTime()).toBe(until.getTime());
      expect(h.last_error).toBe(SPEND_CAP);
    });

    // cm:guard only the mirror expires here; a box-scoped failure recorded AFTER the stamp is a different string and must survive until a job actually succeeds
    it('keeps a box-scoped lastError written after the stamp while clearing the expired limit', async () => {
      const s = await seedRunner({
        lastError: PREFLIGHT,
        limitReason: 'usage_limit',
        limitDetail: SPEND_CAP,
        rateLimitedUntil: new Date(Date.now() - 60_000),
      });
      await mods.mirrorHeartbeatToRunners(s.deviceId);
      const h = await healthOf(s.runnerId);
      expect(h.limit_reason).toBeNull();
      expect(h.limit_detail).toBeNull();
      expect(h.last_error).toBe(PREFLIGHT);
    });

    it('leaves a lastError alone when there was no limit to expire', async () => {
      const s = await seedRunner({ lastError: PREFLIGHT });
      await mods.mirrorHeartbeatToRunners(s.deviceId);
      expect((await healthOf(s.runnerId)).last_error).toBe(PREFLIGHT);
    });
  });

  describe('on the operator reset (POST /:id/runners/:runnerId/clear-error)', () => {
    async function verifiedUser(): Promise<TestUser> {
      const user = await createTestUser(harness.db);
      await harness.db.execute(
        sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`,
      );
      return user;
    }

    // cm:why the caller for a non-admin role MUST be a second user — createTestProject seeds an org owned by its creator, and orgDerivedProjectRole promotes an org owner to project admin, so demoting the creator's project_members row proves nothing
    async function seedFaultedRunnerFor(role: 'admin' | 'member' | 'viewer') {
      const owner = await verifiedUser();
      const project = await createTestProject(harness.db, owner.id);
      let user = owner;
      if (role !== 'admin') {
        user = await verifiedUser();
        await createTestProjectMember(harness.db, {
          userId: user.id,
          projectId: project.id,
          role,
        });
      }
      const device = await createTestDevice(harness.db, owner.id);
      const runnerId = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO runners (id, project_id, device_id, name, type, host, status, last_seen_at,
                             last_error, limit_reason, limit_detail, rate_limited_until,
                             quarantined_until, quarantine_reason)
        VALUES (${runnerId}, ${project.id}, ${device.id}, 'box', 'claude-code', 'device', 'online', now(),
                ${SPEND_CAP}, 'usage_limit', ${SPEND_CAP},
                ${new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()},
                ${new Date(Date.now() + 60 * 60 * 1000).toISOString()},
                'preflight_failed: push_credentials')
      `);
      return { user, projectId: project.id, runnerId };
    }

    async function post(path: string, userId: string) {
      const token = await signUserToken(userId);
      return app.request(path, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      });
    }

    async function quarantineOf(runnerId: string): Promise<string | null> {
      const rows = (await harness.db.execute(
        sql`SELECT quarantine_reason FROM runners WHERE id = ${runnerId}`,
      )) as unknown as { quarantine_reason: string | null }[];
      return rows[0]?.quarantine_reason ?? null;
    }

    // cm:guard an operator reset that leaves ANY fault column set is a button that does not work — a future rate_limited_until or a quarantine keeps the box out of dispatch on its own
    it('clears every fault column at once, including an unexpired limit and quarantine', async () => {
      const s = await seedFaultedRunnerFor('admin');
      const res = await post(
        `/api/projects/${s.projectId}/runners/${s.runnerId}/clear-error`,
        s.user.id,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ runnerId: s.runnerId, cleared: true });

      const h = await healthOf(s.runnerId);
      expect(h.last_error).toBeNull();
      expect(h.limit_reason).toBeNull();
      expect(h.limit_detail).toBeNull();
      expect(h.rate_limited_until).toBeNull();
      expect(await quarantineOf(s.runnerId)).toBeNull();
    });

    it('reports cleared:false on a runner with nothing recorded', async () => {
      const user = await verifiedUser();
      const project = await createTestProject(harness.db, user.id);
      await createTestProjectMember(harness.db, {
        userId: user.id,
        projectId: project.id,
        role: 'admin',
      });
      const device = await createTestDevice(harness.db, user.id);
      const runnerId = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO runners (id, project_id, device_id, name, type, host, status, last_seen_at)
        VALUES (${runnerId}, ${project.id}, ${device.id}, 'box', 'claude-code', 'device', 'online', now())
      `);
      const res = await post(
        `/api/projects/${project.id}/runners/${runnerId}/clear-error`,
        user.id,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ runnerId, cleared: false });
    });

    it('refuses a non-admin member', async () => {
      const s = await seedFaultedRunnerFor('member');
      const res = await post(
        `/api/projects/${s.projectId}/runners/${s.runnerId}/clear-error`,
        s.user.id,
      );
      expect(res.status).toBe(403);
      expect((await healthOf(s.runnerId)).last_error).toBe(SPEND_CAP);
    });

    // cm:guard the runner id must be checked against the projectId in the path — the tenant boundary is the pair, not the id (ISS-492 class)
    it('404s on a runner belonging to another project, leaving it faulted', async () => {
      const mine = await seedFaultedRunnerFor('admin');
      const theirs = await seedFaultedRunnerFor('admin');
      const res = await post(
        `/api/projects/${mine.projectId}/runners/${theirs.runnerId}/clear-error`,
        mine.user.id,
      );
      expect(res.status).toBe(404);
      expect((await healthOf(theirs.runnerId)).last_error).toBe(SPEND_CAP);
    });
  });
});
