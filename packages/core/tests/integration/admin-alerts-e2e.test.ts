/**
 * ISS-652 — GET /api/admin/alerts against real Postgres: the auth gate, the
 * response contract, and A1/A2.
 *
 * A3 lives in `admin-alerts-starvation-e2e.test.ts` and A4/A5 in
 * `admin-alerts-spend-automation-e2e.test.ts`; all three share the harness in
 * `tests/helpers/alert-app.ts` and the seeders in `alert-fixtures.ts`.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AlertApp, findAlert, getAlerts, setupAlertApp } from '../helpers/alert-app.js';
import { type AlertFixtures, alertFixtures } from '../helpers/alert-fixtures.js';
import { createTestProject, createTestUser, truncateAll } from '../helpers/index.js';

describe('admin alert routes (ISS-652)', () => {
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

  describe('auth gate', () => {
    it('401s an unauthenticated request', async () => {
      const res = await ctx.app.request('/api/admin/alerts');
      expect(res.status).toBe(401);
    });

    it('403s ADMIN_ONLY for a non-admin authenticated user', async () => {
      const user = await ctx.verifiedUser('nobody@test.forge.local');
      const { signUserToken } = await import('../../src/auth/jwt.js');
      const { res, error } = await getAlerts(ctx, await signUserToken(user.id));
      expect(res.status).toBe(403);
      expect(error.code).toBe('ADMIN_ONLY');
    });
  });

  describe('response contract', () => {
    // cm:guard assert the WHOLE public shape, not just id/status/count — the Ops Console drills on `entities` and dates the incident from `since`, so a field the route silently stopped populating passes a status-only assertion and reaches the UI as an undrillable alert
    it('200s with exactly 5 items A1-A5, all ok and fully populated, on healthy data', async () => {
      const { res, body } = await getAlerts(ctx, await ctx.adminToken());

      expect(res.status).toBe(200);
      expect(res.headers.get('X-Total-Count')).toBe('5');
      expect(body.map((a) => a.id)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
      expect(body.map((a) => a.key)).toEqual([
        'orphan_jobs',
        'stuck_jobs',
        'runner_starved',
        'spend_spike',
        'automation_failing',
      ]);
      for (const alert of body) {
        expect(alert.status).toBe('ok');
        expect(alert.count).toBe(0);
        expect(alert.detail).toBeTruthy();
        expect(alert.since).toBeNull();
        expect(alert.entities).toEqual([]);
      }
    });
  });

  describe('A1 orphan jobs', () => {
    it('is crit for a job orphaned under a terminal pipeline_run', async () => {
      const owner = await createTestUser(ctx.harness.db);
      const project = await createTestProject(ctx.harness.db, owner.id);
      const run = await fx.insertRun(project.id, 'cancelled');

      // cm:why ISS-448's I1 trigger auto-cancels any active child written under a terminal run; disable it to simulate a pre-existing orphan, same as i1-orphan-trigger.test.ts's backfill case
      await ctx.harness.db.execute(
        sql`ALTER TABLE jobs DISABLE TRIGGER trg_jobs_no_active_under_terminal_run`,
      );
      await fx.insertJob({ projectId: project.id, runId: run, status: 'queued' });
      await ctx.harness.db.execute(
        sql`ALTER TABLE jobs ENABLE TRIGGER trg_jobs_no_active_under_terminal_run`,
      );

      const { body } = await getAlerts(ctx, await ctx.adminToken());
      const a1 = findAlert(body, 'A1');
      expect(a1?.status).toBe('crit');
      expect(a1?.count).toBe(1);
      expect(a1?.entities).toHaveLength(1);
      // cm:guard `since` is typed `string | null` and MUST be an ISO string, not the JS Date postgres-js hands back for a timestamptz — over HTTP the difference is invisible, but computeAlerts is called in-process by the sweeper too, where a consumer calling .startsWith on it throws
      expect(typeof a1?.since).toBe('string');
      expect(new Date(a1?.since ?? '').toISOString()).toBe(a1?.since);
    });
  });

  describe('A2 stuck jobs', () => {
    // cm:guard AC 5 — a `dispatched`-only query (what forge-ops-health.ts does) returns 2 here and fails; a `running` job goes stuck exactly the same way and was the half nobody was told about
    it('catches BOTH dispatched and running past staleSeconds', async () => {
      const owner = await createTestUser(ctx.harness.db);
      const project = await createTestProject(ctx.harness.db, owner.id);
      const run = await fx.insertRun(project.id, 'running');
      for (const status of ['dispatched', 'dispatched', 'running']) {
        await fx.insertJob({
          projectId: project.id,
          runId: run,
          status,
          dispatchedAgoMinutes: 20,
        });
      }

      const token = await ctx.adminToken();
      const { body } = await getAlerts(ctx, token, '?staleSeconds=600');
      const a2 = findAlert(body, 'A2');
      expect(a2?.count).toBe(3);
      expect(a2?.status).not.toBe('ok');

      expect(typeof a2?.since).toBe('string');
      expect(new Date(a2?.since ?? '').toISOString()).toBe(a2?.since);

      const { body: cleared } = await getAlerts(ctx, token, '?staleSeconds=86400');
      expect(findAlert(cleared, 'A2')?.status).toBe('ok');
    });
  });
});
