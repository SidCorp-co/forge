import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

/**
 * ISS-654 — the ghost-runner reaper, proved against real SQL.
 *
 * This pass is a WHERE clause plus one audited write, and the clause is where
 * the damage lives: disabling a box that is still holding a `running` job takes
 * the runner out from under work that is reporting to it. A mocked db returns
 * whatever the test feeds it and is no evidence about which rows are admitted.
 */
describe('reapGhostRunners predicate E2E (ISS-654)', () => {
  let harness: TestDatabase;
  let reapGhostRunners: () => Promise<{ flagged: number }>;
  let projectId: string;
  let ownerId: string;

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

    ({ reapGhostRunners } = await import('../../src/runners/ghost-reaper.js'));
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    projectId = (await createTestProject(harness.db, owner.id)).id;
  });

  async function seedRunner(opts: {
    status?: string;
    lastSeenDaysAgo?: number | null;
  }): Promise<{ runnerId: string; deviceId: string }> {
    const device = await createTestDevice(harness.db, ownerId);
    const runnerId = randomUUID();
    const lastSeen =
      opts.lastSeenDaysAgo === null || opts.lastSeenDaysAgo === undefined
        ? sql`NULL`
        : sql`now() - make_interval(days => ${opts.lastSeenDaysAgo})`;
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, created_at)
      VALUES (${runnerId}, ${projectId}, 'claude-code', ${device.id}, 'ghost-candidate',
              ${opts.status ?? 'offline'}, ${lastSeen}, now() - interval '400 days')
    `);
    return { runnerId, deviceId: device.id };
  }

  /** `jobs.pipeline_run_id` and `agent_sessions.pipeline_run_id` are both NOT NULL. */
  async function seedRun(): Promise<string> {
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, 'system', 'running', now())
    `);
    return runId;
  }

  async function seedJob(runnerId: string, status: string): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, type, status, created_by, runner_id)
      VALUES (${randomUUID()}, ${projectId}, ${await seedRun()}, 'drive', ${status}, ${ownerId}, ${runnerId})
    `);
  }

  async function statusOf(runnerId: string): Promise<string> {
    const rows = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM runners WHERE id = ${runnerId}`,
    );
    return rows[0]?.status ?? 'missing';
  }

  async function setThreshold(days: number): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO admin_thresholds (id, ghost_runner_offline_days)
      VALUES ('singleton', ${days})
      ON CONFLICT (id) DO UPDATE SET ghost_runner_offline_days = ${days}
    `);
  }

  it('disables a runner offline past the configured threshold', async () => {
    const { runnerId } = await seedRunner({ lastSeenDaysAgo: 30 });

    const res = await reapGhostRunners();

    expect(res.flagged).toBe(1);
    expect(await statusOf(runnerId)).toBe('disabled');
  });

  it('leaves a runner offline for less than the threshold', async () => {
    const { runnerId } = await seedRunner({ lastSeenDaysAgo: 3 });

    const res = await reapGhostRunners();

    expect(res.flagged).toBe(0);
    expect(await statusOf(runnerId)).toBe('offline');
  });

  // cm:guard the day count comes from `admin_thresholds`, never a constant — a reaper that ignores the configured value is the whole defect ISS-654 fixes.
  it('follows the configured threshold rather than the default', async () => {
    const { runnerId } = await seedRunner({ lastSeenDaysAgo: 5 });

    expect((await reapGhostRunners()).flagged).toBe(0);

    await setThreshold(3);
    expect((await reapGhostRunners()).flagged).toBe(1);
    expect(await statusOf(runnerId)).toBe('disabled');
  });

  it.each(['dispatched', 'running'])(
    'leaves a long-offline runner still holding a `%s` job',
    async (jobStatus) => {
      const { runnerId } = await seedRunner({ lastSeenDaysAgo: 90 });
      await seedJob(runnerId, jobStatus);

      const res = await reapGhostRunners();

      expect(res.flagged).toBe(0);
      expect(await statusOf(runnerId)).toBe('offline');
    },
  );

  it('flags a long-offline runner whose jobs are all terminal', async () => {
    const { runnerId } = await seedRunner({ lastSeenDaysAgo: 90 });
    await seedJob(runnerId, 'done');
    await seedJob(runnerId, 'failed');

    expect((await reapGhostRunners()).flagged).toBe(1);
    expect(await statusOf(runnerId)).toBe('disabled');
  });

  it('leaves a long-offline runner whose device still holds a live session', async () => {
    const { runnerId, deviceId } = await seedRunner({ lastSeenDaysAgo: 90 });
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, status)
      VALUES (${randomUUID()}, ${projectId}, ${await seedRun()}, ${deviceId}, 'running')
    `);

    const res = await reapGhostRunners();

    expect(res.flagged).toBe(0);
    expect(await statusOf(runnerId)).toBe('offline');
  });

  it.each(['online', 'draining', 'disabled'])(
    'never touches a `%s` runner however old its heartbeat',
    async (status) => {
      const { runnerId } = await seedRunner({ status, lastSeenDaysAgo: 400 });

      const res = await reapGhostRunners();

      expect(res.flagged).toBe(0);
      expect(await statusOf(runnerId)).toBe(status);
    },
  );

  // cm:guard a runner that never heartbeat at all falls back to created_at — a NULL last_seen_at otherwise makes the comparison NULL and the row is silently immortal.
  it('falls back to created_at for a runner that never heartbeat', async () => {
    const { runnerId } = await seedRunner({ lastSeenDaysAgo: null });

    expect((await reapGhostRunners()).flagged).toBe(1);
    expect(await statusOf(runnerId)).toBe('disabled');
  });

  it('writes a runner_events row for each runner it flags', async () => {
    const { runnerId } = await seedRunner({ lastSeenDaysAgo: 90 });

    await reapGhostRunners();

    const rows = await harness.db.execute<{
      old_status: string;
      new_status: string;
      reason: string;
    }>(sql`SELECT old_status, new_status, reason FROM runner_events WHERE runner_id = ${runnerId}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      old_status: 'offline',
      new_status: 'disabled',
      reason: 'ghost',
    });
  });

  it('is idempotent — a second pass flags nothing and writes no second event', async () => {
    const { runnerId } = await seedRunner({ lastSeenDaysAgo: 90 });

    expect((await reapGhostRunners()).flagged).toBe(1);
    expect((await reapGhostRunners()).flagged).toBe(0);

    const rows = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM runner_events WHERE runner_id = ${runnerId}`,
    );
    expect(rows[0]?.n).toBe(1);
  });
});
