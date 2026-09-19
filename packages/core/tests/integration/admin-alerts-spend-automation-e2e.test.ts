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

  it('A4 follows the configured spend_spike_multiple, not a constant', async () => {
    const project = await newProject();
    await fx.insertUsage({ projectId: project.id, cost: 24, recordedAgoHours: 0.5 });
    await fx.insertUsage({ projectId: project.id, cost: 8, recordedAgoHours: 1.5 });

    const token = await ctx.adminToken();

    expect(findAlert((await getAlerts(ctx, token)).body, 'A4')?.status).toBe('warn');

    await setThresholds({ spend_spike_multiple: 10 });

    expect(findAlert((await getAlerts(ctx, token)).body, 'A4')?.status).toBe('ok');
  });

  it('A4 fires crit on the daily ceiling even when the ratio arm reads ok', async () => {
    const project = await newProject();
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

  it('A4 count stays >= 1 on a global-only fire with no per-project contributor', async () => {
    await fx.insertUsage({ projectId: null, cost: 20, recordedAgoHours: 0.5 });

    const { body } = await getAlerts(ctx, await ctx.adminToken());
    const a4 = findAlert(body, 'A4');
    expect(a4?.status).not.toBe('ok');
    expect(a4?.entities).toHaveLength(0);
    expect(a4?.count).toBeGreaterThanOrEqual(1);
  });

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

    await fx.insertPromptSession({
      projectId: project.id,
      scheduleId,
      status: 'completed_via_recovery',
      createdAgoMinutes: 0,
    });
    const { body: cleared } = await getAlerts(ctx, token);
    expect(findAlert(cleared, 'A5')?.status).toBe('ok');
  });

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
