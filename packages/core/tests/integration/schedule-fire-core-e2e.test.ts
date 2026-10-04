// cm:why ISS-112 (design automation rev 1, steps inline, settle and streak; REQ-16 BC-1, BC-5):
// a fire that runs in core writes one schedule_runs row with its output and why, the run history
// reads the fires alone, and alert A5 counts streaks from them, driven through the mounted app,
// the ticker and real Postgres.
// @gate-input whole-tree

import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { seedProjectDocument } from '../helpers/index.js';
import {
  adminBearer,
  call,
  createSchedule,
  firesOf,
  g,
  onlyFire,
  scheduleRow,
  tick,
  useFireGround,
} from './schedule-fire-ground.js';

useFireGround();

describe('a fire that runs in core', () => {
  it('a dispatch that throws: failed, with the thrown error on the row', async () => {
    const scheduleId = await createSchedule({ kind: 'release_batch' });
    await tick(scheduleId);

    const fire = await onlyFire(scheduleId);
    expect(fire.status).toBe('failed');
    expect(fire.error).toMatch(/^dispatch threw: RELEASE_TARGET_UNDECLARED: /);
    expect((await scheduleRow(scheduleId)).lastStatus).toBe('failed');
  });

  it('release_batch on a project with no release gate: skipped, gate-refused, NO_RELEASE_GATE', async () => {
    await seedProjectDocument(g.harness.db, g.projectId, g.adminId, { environments: {} });
    const scheduleId = await createSchedule({ kind: 'release_batch' });
    await tick(scheduleId);

    const fire = await onlyFire(scheduleId);
    expect(fire).toMatchObject({
      trigger: 'scheduled',
      status: 'skipped',
      reason: 'gate-refused',
      refusal: 'NO_RELEASE_GATE',
      sessionId: null,
      output: 'this project has no release gate',
    });
    expect((await scheduleRow(scheduleId)).lastStatus).toBe('skipped');
  });

  it('sentry_pull with no Sentry binding: failed, with the error that says so', async () => {
    const scheduleId = await createSchedule({ kind: 'sentry_pull' });
    await tick(scheduleId);

    const fire = await onlyFire(scheduleId);
    expect(fire.status).toBe('failed');
    expect(fire.error).toMatch(/sentry/i);
    expect((await scheduleRow(scheduleId)).lastStatus).toBe('failed');
  });

  it('script: success with its output, and a ctx.notify carries the fire id', async () => {
    const scheduleId = await createSchedule({
      kind: 'script',
      script: "ctx.log('checked'); ctx.notify({ title: 'nightly check', body: 'all green' });",
    });
    const res = await call('POST', `/api/schedules/${scheduleId}/run`, await adminBearer());
    expect(res.status).toBe(202);
    const body = (await res.json()) as { fireId: string; sessionId: string | null };

    const fire = await onlyFire(scheduleId);
    expect(body).toMatchObject({ fireId: fire.id, sessionId: null });
    expect(fire).toMatchObject({ trigger: 'manual', status: 'success' });
    expect(fire.output).toContain('checked');
    const reports = await g.harness.db
      .select()
      .from(g.m.schema.notifications)
      .where(eq(g.m.schema.notifications.type, 'schedule_report'));
    expect(reports.map((r) => r.scheduleRunId)).toEqual([fire.id]);
  });

  it('script that throws: failed, with its error on the row', async () => {
    const scheduleId = await createSchedule({ kind: 'script', script: "throw new Error('boom');" });
    await tick(scheduleId);

    const fire = await onlyFire(scheduleId);
    expect(fire.status).toBe('failed');
    expect(fire.error).toMatch(/boom/);
  });
});

describe('GET /api/schedules/:id/runs reads the fires alone', () => {
  it('lists one entry per fire, newest first, with why each one ran nothing', async () => {
    const scheduleId = await createSchedule({ prompt: 'tidy the backlog' });
    await tick(scheduleId);
    await g.harness.db.execute(sql`DELETE FROM runners`);
    await tick(scheduleId);

    const res = await call('GET', `/api/schedules/${scheduleId}/runs`, await adminBearer());
    expect(res.status).toBe(200);
    const { runs } = (await res.json()) as { runs: Array<Record<string, unknown>> };
    const fires = await firesOf(scheduleId);
    expect(runs.map((r) => r.id)).toEqual(fires.map((f) => f.id).reverse());
    expect(runs[0]).toMatchObject({ fireStatus: 'skipped', reason: 'no-device', sessionId: null });
    expect(runs[1]).toMatchObject({ fireStatus: 'running', status: 'running' });
    expect(runs[1]?.sessionId).toBe(fires[0]?.sessionId);
  });
});

describe('alert A5 counts streaks from the fires alone', () => {
  async function scheduleWithFires(
    fires: Array<{ status: string; reason?: string; refusal?: string }>,
  ): Promise<string> {
    const scheduleId = await createSchedule({ prompt: 'streak subject' });
    const start = Date.now() - fires.length * 60_000;
    for (const [i, f] of fires.entries()) {
      const at = new Date(start + i * 60_000);
      await g.harness.db.insert(g.m.schema.scheduleRuns).values({
        scheduleId,
        projectId: g.projectId,
        trigger: 'scheduled',
        status: f.status as 'success' | 'failed' | 'skipped',
        reason: (f.reason ?? null) as 'no-device' | null,
        startedAt: at,
        finishedAt: at,
        createdAt: at,
      });
    }
    return scheduleId;
  }

  async function failingSchedules(): Promise<string[]> {
    const alerts = await g.m.alerts.computeAlerts({
      thresholds: { ...g.m.thresholds.ADMIN_THRESHOLD_DEFAULTS, scheduleFailStreak: 2 },
    });
    const a5 = alerts.find((a) => a.key === 'automation_failing');
    return (a5?.entities ?? []).filter((e) => e.kind === 'schedule').map((e) => e.ref);
  }

  it('a no-device skip counts toward the streak', async () => {
    const id = await scheduleWithFires([
      { status: 'failed' },
      { status: 'skipped', reason: 'no-device' },
    ]);
    expect(await failingSchedules()).toContain(id);
  });

  it('an already-applied skip does not count toward it', async () => {
    const id = await scheduleWithFires([
      { status: 'skipped', reason: 'already-applied' },
      { status: 'skipped', reason: 'already-applied' },
      { status: 'failed' },
    ]);
    expect(await failingSchedules()).not.toContain(id);
  });

  it('a success clears the streak', async () => {
    const id = await scheduleWithFires([
      { status: 'failed' },
      { status: 'failed' },
      { status: 'success' },
    ]);
    expect(await failingSchedules()).not.toContain(id);
  });
});
