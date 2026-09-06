/**
 * ISS-652 — A4 (`spend_spike`) and A5 (`automation_failing`) against real
 * Postgres. Both aggregate over history tables (`usage_records`,
 * `schedule_runs` via `agent_sessions`, `integration_deliveries`) where the
 * shape of what is EXCLUDED is the whole correctness question.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AlertApp, findAlert, getAlerts, setupAlertApp } from '../helpers/alert-app.js';
import { type AlertFixtures, alertFixtures } from '../helpers/alert-fixtures.js';
import { createTestProject, createTestUser, truncateAll } from '../helpers/index.js';

describe('A4 spend spike + A5 automation failures (ISS-652)', () => {
  let ctx: AlertApp;
  let fx: AlertFixtures;

  beforeAll(async () => {
    ctx = await setupAlertApp();
    fx = alertFixtures(ctx.harness);
  }, 120_000);

  afterAll(async () => {
    if (ctx?.harness) await ctx.harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(ctx.harness.db);
  });

  async function newProject() {
    const owner = await createTestUser(ctx.harness.db);
    return createTestProject(ctx.harness.db, owner.id);
  }

  /** Writes the singleton `admin_thresholds` row the alert engine reads per call. */
  async function setThresholds(patch: Record<string, unknown>): Promise<void> {
    const cols = Object.keys(patch);
    const setList = sql.join(
      cols.map((c) => sql`${sql.raw(`"${c}"`)} = ${patch[c]}`),
      sql`, `,
    );
    const colList = sql.join(
      cols.map((c) => sql.raw(`"${c}"`)),
      sql`, `,
    );
    const valList = sql.join(
      cols.map((c) => sql`${patch[c]}`),
      sql`, `,
    );
    await ctx.harness.db.execute(sql`
      INSERT INTO admin_thresholds (id, ${colList}) VALUES ('singleton', ${valList})
      ON CONFLICT (id) DO UPDATE SET ${setList}
    `);
  }

  // cm:guard ISS-654 — `computeAlerts` must read `admin_thresholds` on EVERY call. This pair is the only evidence that it does: the same rows classify differently once the row is written, which a process-lifetime read of the config cannot produce.
  it('A4 follows the configured spend_spike_multiple, not a constant', async () => {
    const project = await newProject();
    await fx.insertUsage({ projectId: project.id, cost: 24, recordedAgoHours: 0.5 });
    await fx.insertUsage({ projectId: project.id, cost: 8, recordedAgoHours: 1.5 });

    // cm:guard one token per test — `adminToken()` INSERTs the admin user, so a second call inside one test collides on the unique email and the failure reads as an alert-engine bug
    const token = await ctx.adminToken();

    expect(findAlert((await getAlerts(ctx, token)).body, 'A4')?.status).toBe('warn');

    await setThresholds({ spend_spike_multiple: 10 });

    expect(findAlert((await getAlerts(ctx, token)).body, 'A4')?.status).toBe('ok');
  });

  // cm:guard the ceiling arm reads a trailing 24h, never the ratio arm's 1-hour window — comparing an hour of spend to a day's allowance never fires.
  it('A4 fires crit on the daily ceiling even when the ratio arm reads ok', async () => {
    const project = await newProject();
    // cm:why flat across both ratio windows on purpose — ratio 1.0 reads `ok`, so anything this test sees fire came from the ceiling arm and nowhere else
    await fx.insertUsage({ projectId: project.id, cost: 60, recordedAgoHours: 0.5 });
    await fx.insertUsage({ projectId: project.id, cost: 60, recordedAgoHours: 1.5 });
    await fx.insertUsage({ projectId: project.id, cost: 60, recordedAgoHours: 10 });

    const token = await ctx.adminToken();
    expect(findAlert((await getAlerts(ctx, token)).body, 'A4')?.status).toBe('ok');

    await setThresholds({ spend_ceiling_usd_day: 100 });

    const after = findAlert((await getAlerts(ctx, token)).body, 'A4');
    expect(after?.status).toBe('crit');
    expect(after?.detail).toContain('ceiling');
  });

  it('A4 warns at 80% of the ceiling, before the breach', async () => {
    const project = await newProject();
    await fx.insertUsage({ projectId: project.id, cost: 42, recordedAgoHours: 0.5 });
    await fx.insertUsage({ projectId: project.id, cost: 42, recordedAgoHours: 1.5 });
    await setThresholds({ spend_ceiling_usd_day: 100 });

    const a4 = findAlert((await getAlerts(ctx, await ctx.adminToken())).body, 'A4');
    expect(a4?.status).toBe('warn');
  });

  it('A5 follows the configured schedule_fail_streak, not a constant', async () => {
    const project = await newProject();
    const scheduleId = await fx.insertPromptSchedule(project.id);
    for (const createdAgoMinutes of [2, 1]) {
      await fx.insertPromptSession({
        projectId: project.id,
        scheduleId,
        status: 'failed',
        createdAgoMinutes,
      });
    }

    const token = await ctx.adminToken();

    await setThresholds({ schedule_fail_streak: 3 });
    expect(findAlert((await getAlerts(ctx, token)).body, 'A5')?.status).toBe('ok');

    await setThresholds({ schedule_fail_streak: 2 });
    expect(findAlert((await getAlerts(ctx, token)).body, 'A5')?.status).toBe('warn');
  });

  it('A4 fires crit for a project whose current-window spend ratio clears the crit threshold', async () => {
    const project = await newProject();
    await fx.insertUsage({ projectId: project.id, cost: 20, recordedAgoHours: 0.5 });
    await fx.insertUsage({ projectId: project.id, cost: 2, recordedAgoHours: 1.5 });

    const { body } = await getAlerts(ctx, await ctx.adminToken());
    const a4 = findAlert(body, 'A4');
    expect(a4?.status).toBe('crit');
    expect(a4?.count).toBeGreaterThanOrEqual(1);
  });

  // cm:guard a global-only fire (no single project individually crosses the ratio — e.g. project_id-less system usage) must still report count >= 1, never 0, or a consumer filtering on `count > 0` silently drops a live spend spike
  it('A4 count stays >= 1 on a global-only fire with no per-project contributor', async () => {
    await fx.insertUsage({ projectId: null, cost: 20, recordedAgoHours: 0.5 });

    const { body } = await getAlerts(ctx, await ctx.adminToken());
    const a4 = findAlert(body, 'A4');
    expect(a4?.status).not.toBe('ok');
    expect(a4?.entities).toHaveLength(0);
    expect(a4?.count).toBeGreaterThanOrEqual(1);
  });

  // cm:guard inbound webhook deliveries (which Coolify records `ok` even when the deploy it reports failed) must not dilute a real OUTBOUND delivery fail-rate — the two directions answer different questions and averaging them hides the one Forge controls
  it('A5 fires on an outbound fail-rate even when inbound deliveries are all ok', async () => {
    const project = await newProject();
    const bindingId = await fx.insertBinding(project.id);
    for (let i = 0; i < 5; i++) {
      await fx.insertDelivery({ bindingId, direction: 'inbound', status: 'ok' });
    }
    for (let i = 0; i < 4; i++) {
      await fx.insertDelivery({ bindingId, direction: 'outbound', status: 'failed' });
    }
    await fx.insertDelivery({ bindingId, direction: 'outbound', status: 'ok' });

    const { body } = await getAlerts(ctx, await ctx.adminToken());
    const a5 = findAlert(body, 'A5');
    expect(a5?.status).not.toBe('ok');
    expect(a5?.count).toBeGreaterThanOrEqual(1);
  });

  it('A5 stays ok when only inbound deliveries are failing', async () => {
    const project = await newProject();
    const bindingId = await fx.insertBinding(project.id);
    for (let i = 0; i < 5; i++) {
      await fx.insertDelivery({ bindingId, direction: 'inbound', status: 'failed' });
      await fx.insertDelivery({ bindingId, direction: 'outbound', status: 'ok' });
    }

    const { body } = await getAlerts(ctx, await ctx.adminToken());
    expect(findAlert(body, 'A5')?.status).toBe('ok');
  });

  it('A5 catches a trailing failure streak from prompt schedule sessions', async () => {
    const project = await newProject();
    const scheduleId = await fx.insertPromptSchedule(project.id);
    for (let i = 0; i < 3; i++) {
      await fx.insertPromptSession({
        projectId: project.id,
        scheduleId,
        status: 'failed',
        createdAgoMinutes: 3 - i,
      });
    }

    const token = await ctx.adminToken();
    const { body } = await getAlerts(ctx, token);
    const a5 = findAlert(body, 'A5');
    expect(a5?.status).toBe('warn');
    expect(a5?.count).toBe(1);

    // cm:why a recovery counts as a success and ends the streak — the streak is read back from the most recent FINISHED session, so a later good run clears it without any resolve step
    await fx.insertPromptSession({
      projectId: project.id,
      scheduleId,
      status: 'completed_via_recovery',
      createdAgoMinutes: 0,
    });
    const { body: cleared } = await getAlerts(ctx, token);
    expect(findAlert(cleared, 'A5')?.status).toBe('ok');
  });

  // cm:guard this case is the only thing standing between a perf pass and a silent A5 regression — it spreads the streak across 40 days so a time bound on the schedule_events scan drops the two older failures and leaves streak=1 with no alert, while last_run_at still admits the schedule; every other schedule event in this suite is 0-3 minutes old and would survive any bound anyone is likely to add
  it('A5 catches a streak spanning weeks, so a time bound on the event scan cannot pass', async () => {
    const project = await newProject();
    const scheduleId = await fx.insertPromptSchedule(project.id);
    for (const createdAgoMinutes of [40 * 24 * 60, 20 * 24 * 60, 60]) {
      await fx.insertPromptSession({
        projectId: project.id,
        scheduleId,
        status: 'failed',
        createdAgoMinutes,
      });
    }

    const { body } = await getAlerts(ctx, await ctx.adminToken());
    const a5 = findAlert(body, 'A5');
    expect(a5?.status).toBe('warn');
    expect(a5?.count).toBe(1);
  });
});
