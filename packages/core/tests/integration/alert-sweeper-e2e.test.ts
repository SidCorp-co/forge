/**
 * ISS-652 — `runAlertSweep` against real Postgres, modelled on
 * stranded-issues-e2e.test.ts. Uses A1 (orphan jobs) as the vehicle since it
 * is the simplest alert to force into crit: dedup → escalate → clear.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  runAlertSweep: typeof import('../../src/admin/alert-sweeper.js').runAlertSweep;
};

describe('runAlertSweep E2E (ISS-652)', () => {
  let harness: TestDatabase;
  let mods: Mods;

  const ADMIN_EMAIL = 'admin@test.forge.local';
  const ADMIN_EMAIL_2 = 'admin2@test.forge.local';

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
    // cm:why both addresses baked in up front — config/env.ts parses ADMIN_EMAILS once at import time, so it cannot be changed per-test; a test seeding only one of the two never triggers the other's row
    process.env.ADMIN_EMAILS = `${ADMIN_EMAIL},${ADMIN_EMAIL_2}`;

    mods = (await import('../../src/admin/alert-sweeper.js')) as unknown as Mods;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  // cm:why the in-process sweep-interval gate is a real module-level singleton across this whole file (not reset per test); each call must pass a `now` strictly >5min past every prior call so the gate never skips a sweep this suite depends on
  let clockMs = Date.parse('2026-01-01T00:00:00Z');
  function nextNow(): Date {
    clockMs += 10 * 60_000;
    return new Date(clockMs);
  }

  async function seedAdmin() {
    const admin = await createTestUser(harness.db, { email: ADMIN_EMAIL });
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${admin.id}`,
    );
    return admin;
  }

  async function seedSecondAdmin() {
    const admin = await createTestUser(harness.db, { email: ADMIN_EMAIL_2 });
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${admin.id}`,
    );
    return admin;
  }

  /** On the ADMIN_EMAILS allow-list, but never verified — must not be notified. */
  async function seedUnverifiedAdmin() {
    return createTestUser(harness.db, { email: ADMIN_EMAIL });
  }

  async function seedOrphan() {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at)
      VALUES (${runId}, ${project.id}, 'system', 'cancelled', now(), now())
    `);
    const jobId = randomUUID();
    await harness.db.execute(
      sql`ALTER TABLE jobs DISABLE TRIGGER trg_jobs_no_active_under_terminal_run`,
    );
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, type, status, payload, pipeline_run_id, created_by)
      VALUES (${jobId}, ${project.id}, 'code', 'queued', '{}'::jsonb, ${runId}, ${owner.id})
    `);
    await harness.db.execute(
      sql`ALTER TABLE jobs ENABLE TRIGGER trg_jobs_no_active_under_terminal_run`,
    );
    return { projectId: project.id, runId, jobId };
  }

  async function clearOrphan(jobId: string) {
    await harness.db.execute(
      sql`ALTER TABLE jobs DISABLE TRIGGER trg_jobs_no_active_under_terminal_run`,
    );
    await harness.db.execute(sql`UPDATE jobs SET status = 'cancelled' WHERE id = ${jobId}`);
    await harness.db.execute(
      sql`ALTER TABLE jobs ENABLE TRIGGER trg_jobs_no_active_under_terminal_run`,
    );
  }

  /** Jobs dispatched `ageSeconds` ago under a still-running pipeline_run: A2 fodder, invisible to A1 and A3. */
  async function seedStuckJobs(count: number, ageSeconds: number) {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
      VALUES (${runId}, ${project.id}, 'system', 'running', now())
    `);
    for (let i = 0; i < count; i++) {
      await harness.db.execute(sql`
        INSERT INTO jobs (id, project_id, type, status, payload, pipeline_run_id, created_by, queued_at, dispatched_at)
        VALUES (${randomUUID()}, ${project.id}, 'code', 'running', '{}'::jsonb, ${runId}, ${owner.id},
                now() - (${ageSeconds}::int * interval '1 second'),
                now() - (${ageSeconds}::int * interval '1 second'))
      `);
    }
  }

  async function opsAlertRows(resolutionKey = 'ops-alert:A1') {
    const rows = await harness.db.execute<{
      id: string;
      user_id: string;
      severity: string | null;
      read: boolean;
      resolved_at: Date | null;
      resolution_key: string;
    }>(sql`
      SELECT id, user_id, severity, read, resolved_at, resolution_key FROM notifications
      WHERE type = 'ops_alert' AND resolution_key = ${resolutionKey}
    `);
    return rows as unknown as Array<{
      id: string;
      user_id: string;
      severity: string | null;
      read: boolean;
      resolved_at: Date | null;
      resolution_key: string;
    }>;
  }

  it('writes exactly one unread notification per admin when A1 crosses into crit', async () => {
    const admin = await seedAdmin();
    await seedOrphan();

    const result = await mods.runAlertSweep(nextNow());
    expect(result.notified).toBeGreaterThan(0);

    const rows = await opsAlertRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.user_id === admin.id)).toBe(true);
    expect(rows.every((r) => r.severity === 'error')).toBe(true);
    expect(rows.every((r) => !r.read)).toBe(true);
  });

  it('dedups: a second sweep of the same unresolved condition adds no new rows', async () => {
    await seedAdmin();
    await seedOrphan();

    const first = await mods.runAlertSweep(nextNow());
    expect(first.notified).toBeGreaterThan(0);
    const countAfterFirst = (await opsAlertRows()).length;

    const second = await mods.runAlertSweep(nextNow());
    expect(second.notified).toBe(0);
    expect((await opsAlertRows()).length).toBe(countAfterFirst);
  });

  it('does not re-alert after an active notification is acknowledged', async () => {
    await seedAdmin();
    await seedOrphan();

    await mods.runAlertSweep(nextNow());
    const [created] = await opsAlertRows();
    expect(created).toBeDefined();
    await harness.db.execute(sql`
      UPDATE notifications SET read = true WHERE id = ${created?.id}
    `);

    const repeated = await mods.runAlertSweep(nextNow());
    const rows = await opsAlertRows();
    expect(repeated.notified).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(created?.id);
    expect(rows[0]?.read).toBe(true);
    expect(rows[0]?.resolved_at).toBeNull();
  });

  it('clears via resolveNotifications once the orphan is gone', async () => {
    await seedAdmin();
    const { jobId } = await seedOrphan();

    await mods.runAlertSweep(nextNow());
    expect((await opsAlertRows()).every((r) => !r.read)).toBe(true);

    await clearOrphan(jobId);
    const cleared = await mods.runAlertSweep(nextNow());
    expect(cleared.resolved).toBeGreaterThan(0);
    expect((await opsAlertRows()).every((r) => r.read && r.resolved_at !== null)).toBe(true);
  });

  // cm:why no seedAdmin() call — ADMIN_EMAILS is non-empty (set in beforeAll) but no users row matches it, so platformAdminUserIds() is empty
  it('notifies nobody when no user matches the ADMIN_EMAILS allow-list, without throwing', async () => {
    await seedOrphan();
    await expect(mods.runAlertSweep(nextNow())).resolves.toMatchObject({
      notified: 0,
      evaluated: 5,
    });
  });

  // cm:guard dedupe/claim must be per (userId, resolutionKey), not a single global check — two distinct admins must each get their own unread row
  it('writes a distinct row per admin, not a single global row', async () => {
    const admin1 = await seedAdmin();
    const admin2 = await seedSecondAdmin();
    await seedOrphan();

    const result = await mods.runAlertSweep(nextNow());
    expect(result.notified).toBe(2);

    const rows = await opsAlertRows();
    const userIds = rows.map((r) => r.user_id).sort();
    expect(userIds).toEqual([admin1.id, admin2.id].sort());
  });

  // cm:guard escalation must stay in place on the ONE unread row (the unique index forbids a second) — a resolve-then-re-emit would leave a read row plus a new one for the same live condition
  it('escalates warn -> crit on the same unread row', async () => {
    const admin = await seedAdmin();
    await seedStuckJobs(1, 700);

    await mods.runAlertSweep(nextNow());
    const warnRows = await opsAlertRows('ops-alert:A2');
    expect(warnRows).toHaveLength(1);
    expect(warnRows[0]?.severity).toBe('warning');

    await seedStuckJobs(2, 700);
    const escalated = await mods.runAlertSweep(nextNow());
    expect(escalated.notified).toBeGreaterThan(0);

    const critRows = await opsAlertRows('ops-alert:A2');
    expect(critRows).toHaveLength(1);
    expect(critRows[0]?.user_id).toBe(admin.id);
    expect(critRows[0]?.severity).toBe('error');
    expect(critRows[0]?.read).toBe(false);
  });

  // cm:guard platformAdminUserIds() must require a verified email — an allow-listed-but-unverified account must not receive cross-tenant alert details
  it('does not notify an admin whose email is unverified', async () => {
    await seedUnverifiedAdmin();
    await seedOrphan();

    const result = await mods.runAlertSweep(nextNow());
    expect(result.notified).toBe(0);
    expect(await opsAlertRows()).toHaveLength(0);
  });
});
