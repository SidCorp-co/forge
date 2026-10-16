/**
 * REQ-22 (ISS-547): the operator console lists every alert with its level and when that level
 * changed, and an alert crossing into warn or crit reaches the operator's bell. A stuck job is
 * planted on a throwaway Postgres and walked ok -> warn -> crit -> ok through the same sweep the
 * five-minute cluster timer runs, read back through `GET /api/admin/alerts` and the bell.
 *
 * @direct-test-of packages/core/src/admin/alert-sweeper.ts
 * @direct-test-of packages/core/src/admin/alert-queries.ts
 * @direct-test-of packages/core/src/notifications/ops-alerts.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// env is read once, on first use: the operator list is set before anything imports it
vi.hoisted(() => {
  process.env.ADMIN_EMAILS = 'operator@ops-alert-crossing.test';
});

import { runAlertSweep } from '../../src/admin/alert-sweeper.js';
import { db } from '../../src/db/client.js';
import { logger } from '../../src/lib/logger.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows } from '../helpers/factories.js';

interface Alert {
  id: string;
  status: 'ok' | 'warn' | 'crit';
  changedAt: string | null;
}
interface Bell {
  type: string;
  severity: string;
  readAt: string | null;
  title: string;
}

let operator = '';
let bystander = '';
let operatorToken = '';
let bystanderToken = '';
let projectId = '';
let jobId = '';

beforeAll(async () => {
  testEnv();
  operator = (await createTestUser({ email: 'operator@ops-alert-crossing.test', verified: true }))
    .id;
  bystander = (await createTestUser({ verified: true })).id;
  operatorToken = await userToken(operator);
  bystanderToken = await userToken(bystander);
  projectId = (await createTestProject(operator)).id;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** A job dispatched `ageSeconds` ago and never finished: A2 reads it stuck past 600 s. */
async function plantStuckJob(ageSeconds: number): Promise<void> {
  const runId = randomUUID();
  jobId = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${projectId}, 'interactive', 'running')
  `);
  await db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, created_by, type, status, payload, dispatched_at)
    VALUES (${jobId}, ${projectId}, ${runId}, ${operator}, 'smoke', 'dispatched', '{}'::jsonb,
            now() - (${ageSeconds}::int * interval '1 second'))
  `);
}

async function ageJob(ageSeconds: number): Promise<void> {
  await db.execute(sql`
    UPDATE jobs SET dispatched_at = now() - (${ageSeconds}::int * interval '1 second')
    WHERE id = ${jobId}
  `);
}

async function alertsConsole(): Promise<Map<string, Alert>> {
  const res = await api(operatorToken, 'GET', '/api/admin/alerts');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const items = res.body.items as Alert[];
  return new Map(items.map((a) => [a.id, a]));
}

/** The bell's open deliveries of ops alerts; the sweep writes each delivery in its own call. */
async function bell(token: string): Promise<Bell[]> {
  const res = await api(token, 'GET', '/api/notifications');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.items as Bell[]).filter((b) => b.type === 'ops_alert');
}

async function markAllRead(token: string): Promise<void> {
  const res = await api(token, 'POST', '/api/notifications/mark-all-read', {});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

describe('REQ-22 operator alerts, planted on a throwaway Postgres', () => {
  it("the console is the operator's alone", async () => {
    const res = await api(bystanderToken, 'GET', '/api/admin/alerts');
    expect(res.status).toBe(403);
  });

  it('lists all six alerts at ok, none with a change time, before anything has crossed', async () => {
    const alerts = await alertsConsole();
    expect([...alerts.keys()]).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
    for (const a of alerts.values()) {
      expect(a.status, a.id).toBe('ok');
      expect(a.changedAt, a.id).toBeNull();
    }
  });

  it('a crossing into warn notifies the operator and stamps when the level changed', async () => {
    await plantStuckJob(700);
    expect((await alertsConsole()).get('A2')).toMatchObject({ status: 'warn', changedAt: null });

    const swept = await runAlertSweep();
    expect(swept).toMatchObject({ evaluated: 6, notified: 1 });

    const operatorBell = await bell(operatorToken);
    expect(operatorBell).toHaveLength(1);
    expect(operatorBell[0]).toMatchObject({ severity: 'warning', readAt: null });
    expect(operatorBell[0]?.title).toContain('Stuck jobs detected');
    expect(await bell(bystanderToken)).toHaveLength(0);

    const [record] = await rows<{ level_changed_at: Date | string }>(sql`
      SELECT level_changed_at FROM notifications
      WHERE type = 'ops_alert' AND resolution_key = 'ops-alert:A2' AND resolved_at IS NULL
    `);
    const a2 = (await alertsConsole()).get('A2');
    expect(a2?.status).toBe('warn');
    expect(a2?.changedAt).toBe(new Date(record?.level_changed_at as string).toISOString());
  });

  it('holding at warn tells nobody again and keeps the change time', async () => {
    const before = (await alertsConsole()).get('A2')?.changedAt;
    await markAllRead(operatorToken);
    const swept = await runAlertSweep();
    expect(swept.notified).toBe(0);
    expect((await bell(operatorToken))[0]?.readAt).not.toBeNull();
    expect((await alertsConsole()).get('A2')?.changedAt).toBe(before);
  });

  it('a crossing from warn into crit reaches the operator again, at the new level', async () => {
    const warnAt = (await alertsConsole()).get('A2')?.changedAt as string;
    await ageJob(3000);
    const swept = await runAlertSweep();
    expect(swept.notified).toBe(1);

    const operatorBell = await bell(operatorToken);
    expect(operatorBell).toHaveLength(1);
    expect(operatorBell[0]).toMatchObject({ severity: 'error', readAt: null });

    const a2 = (await alertsConsole()).get('A2');
    expect(a2?.status).toBe('crit');
    expect(a2?.changedAt).not.toBeNull();
    expect(Date.parse(a2?.changedAt as string)).toBeGreaterThan(Date.parse(warnAt));
  });

  it('a return to ok resolves the notice and the console shows when it went back', async () => {
    // a job's status moves only through the kernel, so the job goes back under the threshold
    await ageJob(10);
    const swept = await runAlertSweep();
    expect(swept.resolved).toBe(1);

    const [record] = await rows<{ resolved_at: Date | string | null }>(sql`
      SELECT resolved_at FROM notifications WHERE type = 'ops_alert' AND resolution_key = 'ops-alert:A2'
    `);
    expect(record?.resolved_at).not.toBeNull();
    const a2 = (await alertsConsole()).get('A2');
    expect(a2?.status).toBe('ok');
    expect(a2?.changedAt).toBe(new Date(record?.resolved_at as string).toISOString());
  });

  it('a crossing with no operator to tell says so in the log instead of telling nobody quietly', async () => {
    await db.execute(sql`UPDATE users SET email_verified_at = NULL WHERE id = ${operator}`);
    const warn = vi.spyOn(logger, 'warn');
    try {
      await ageJob(700);
      const swept = await runAlertSweep();
      expect(swept.notified).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        { alerts: ['A2'] },
        expect.stringContaining('ADMIN_EMAILS names no user with a verified email'),
      );
    } finally {
      warn.mockRestore();
      await db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${operator}`);
    }
  });
});
