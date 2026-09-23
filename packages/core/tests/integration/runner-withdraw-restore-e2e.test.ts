/**
 * A runner withdrawn to `disabled` must be reachable back into the pool, and a
 * registration that cannot create its row must say so by name (ISS-990).
 *
 * Both halves need a real database. The refusal is recognised by the constraint
 * NAME Postgres reports, so only a real `runners_project_device_type_uq` proves
 * the string is the one the index actually raises; and "the pool admits it
 * again" is a fact about two SQL predicates — `ADMITTED_RUNNER` and the
 * dispatch picker's `status = 'online'` — that a mocked db cannot evaluate.
 */

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

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  insertRunner: typeof import('../../src/runners/service.js').insertRunner;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  RunnerAlreadyBoundError: typeof import('../../src/runners/service.js').RunnerAlreadyBoundError;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  setRunnerStatus: typeof import('../../src/runners/runner-events.js').setRunnerStatus;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  onlineCapableDeviceIds: typeof import('../../src/runners/select.js').onlineCapableDeviceIds;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  runnerAdmission: typeof import('../../src/devices/pool-admission.js').runnerAdmission;
};

describe('a withdrawn runner and the way back', () => {
  let harness: TestDatabase;
  let mods: Mods;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';

    const service = await import('../../src/runners/service.js');
    const events = await import('../../src/runners/runner-events.js');
    const select = await import('../../src/runners/select.js');
    const admission = await import('../../src/devices/pool-admission.js');
    mods = {
      insertRunner: service.insertRunner,
      RunnerAlreadyBoundError: service.RunnerAlreadyBoundError,
      setRunnerStatus: events.setRunnerStatus,
      onlineCapableDeviceIds: select.onlineCapableDeviceIds,
      runnerAdmission: admission.runnerAdmission,
    };
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seed() {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const device = await createTestDevice(harness.db, owner.id);
    const runnerId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, name, type, status, last_seen_at,
                           capabilities, provision_status)
      VALUES (${runnerId}, ${project.id}, ${device.id}, 'forge-vm', 'claude-code', 'online', now(),
              '{}'::jsonb, 'ready')
    `);
    return { runnerId, projectId: project.id, deviceId: device.id, ownerId: owner.id };
  }

  const statusOf = async (runnerId: string) =>
    (
      (await harness.db.execute(
        sql`SELECT status FROM runners WHERE id = ${runnerId}`,
      )) as unknown as Array<{ status: string }>
    )[0]?.status;

  describe('the round trip', () => {
    it('takes a retired runner out of the dispatch picker and puts it back, with no heartbeat in between', async () => {
      const s = await seed();
      expect(await mods.onlineCapableDeviceIds(s.projectId)).toContain(s.deviceId);

      await mods.setRunnerStatus({ runnerId: s.runnerId, newStatus: 'disabled', reason: 'test' });
      expect(await mods.onlineCapableDeviceIds(s.projectId)).not.toContain(s.deviceId);

      await mods.setRunnerStatus({ runnerId: s.runnerId, newStatus: 'online', reason: 'test' });

      expect(await mods.onlineCapableDeviceIds(s.projectId)).toContain(s.deviceId);
      expect(await statusOf(s.runnerId)).toBe('online');
    });

    it('is not restored by `offline`, which the picker rejects on a live box', async () => {
      const s = await seed();
      await mods.setRunnerStatus({ runnerId: s.runnerId, newStatus: 'disabled', reason: 'test' });

      await mods.setRunnerStatus({ runnerId: s.runnerId, newStatus: 'offline', reason: 'test' });

      expect(await mods.onlineCapableDeviceIds(s.projectId)).not.toContain(s.deviceId);
    });

    it('readmits the runner to the pool predicate as well as the picker', async () => {
      const s = await seed();
      const runId = randomUUID();
      const jobId = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, status, kind)
        VALUES (${runId}, ${s.projectId}, 'running', 'system')
      `);
      await harness.db.execute(sql`
        INSERT INTO jobs (id, project_id, pipeline_run_id, device_id, type, status, created_by)
        VALUES (${jobId}, ${s.projectId}, ${runId}, ${s.deviceId}, 'drive', 'queued', ${s.ownerId})
      `);

      await mods.setRunnerStatus({ runnerId: s.runnerId, newStatus: 'disabled', reason: 'test' });
      expect(await mods.runnerAdmission({ jobId, deviceId: s.deviceId })).toEqual({
        admitted: false,
        reason: 'runner_withdrawn',
      });

      await mods.setRunnerStatus({ runnerId: s.runnerId, newStatus: 'online', reason: 'test' });
      expect(await mods.runnerAdmission({ jobId, deviceId: s.deviceId })).toEqual({
        admitted: true,
      });
    });
  });

  describe('registering over an existing binding', () => {
    const register = (projectId: string, deviceId: string) =>
      mods.insertRunner({
        projectId,
        type: 'claude-code',
        deviceId,
        name: 'forge-vm again',
        labels: [],
        capabilities: {},
        config: {},
      });

    it('is refused by name, naming the runner it collided with', async () => {
      const s = await seed();
      await mods.setRunnerStatus({ runnerId: s.runnerId, newStatus: 'disabled', reason: 'test' });

      const err = await register(s.projectId, s.deviceId).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(mods.RunnerAlreadyBoundError);
      expect((err as Error).message).toContain(s.runnerId);
      expect((err as Error).message).toContain('forge-vm');
    });

    it('sends a retired collider to restore, which is the route that works', async () => {
      const s = await seed();
      await mods.setRunnerStatus({ runnerId: s.runnerId, newStatus: 'disabled', reason: 'test' });

      const err = (await register(s.projectId, s.deviceId).catch((e: unknown) => e)) as Error;

      expect(err.message).toMatch(/restore it/i);
      expect(err.message).not.toMatch(/re-register/i);
    });

    it('leaves the existing row untouched, so a refused registration costs the operator nothing', async () => {
      const s = await seed();
      await mods.setRunnerStatus({ runnerId: s.runnerId, newStatus: 'disabled', reason: 'test' });

      await register(s.projectId, s.deviceId).catch(() => undefined);

      const rows = (await harness.db.execute(
        sql`SELECT id, status FROM runners WHERE project_id = ${s.projectId}`,
      )) as unknown as Array<{ id: string; status: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('disabled');
    });

    it('still registers the same device for a DIFFERENT project, which the index permits', async () => {
      const s = await seed();
      const other = await createTestProject(harness.db, s.ownerId);

      const row = await register(other.id, s.deviceId);

      expect(row.projectId).toBe(other.id);
    });
  });
});
