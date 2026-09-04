/**
 * A limit belongs to the BOX's agent account, not to one project's binding.
 *
 * One daemon holds one Claude login, but `runners` carries a row per
 * (device × project), and both the stamp and the clear were scoped to the row
 * that happened to run the job. Measured on forge-beta 2026-09-04: three
 * devices sat `limit_reason='auth'` on exactly ONE binding each while 7, 1 and
 * 1 sibling projects read perfectly healthy and kept dispatching into the same
 * dead OAuth session — the shape that burned 421 jobs in 5.5h on dev1-ai013.
 * `auth` carries no reset time, so nothing self-heals it.
 *
 * The write is what makes the existing per-project reads correct, so it needs a
 * real database: the scope is a correlated subquery, and a mocked db can only
 * assert the string.
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
  stampRunnerLimit: typeof import('../../src/runners/apply-runner-limit.js').stampRunnerLimit;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  clearRunnerLimit: typeof import('../../src/runners/apply-runner-limit.js').clearRunnerLimit;
};

interface HealthRow {
  id: string;
  limit_reason: string | null;
  limit_detail: string | null;
  last_error: string | null;
}

describe('a runner limit reaches every binding of its device', () => {
  let harness: TestDatabase;
  let mods: Mods;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';

    const limitMod = await import('../../src/runners/apply-runner-limit.js');
    mods = {
      stampRunnerLimit: limitMod.stampRunnerLimit,
      clearRunnerLimit: limitMod.clearRunnerLimit,
    };
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  /** One box bound to two projects, plus an unrelated box that must not move. */
  async function seedTwoBindings() {
    const owner = await createTestUser(harness.db);
    const projectA = await createTestProject(harness.db, owner.id);
    const projectB = await createTestProject(harness.db, owner.id);
    const projectC = await createTestProject(harness.db, owner.id);
    const box = await createTestDevice(harness.db, owner.id);
    const other = await createTestDevice(harness.db, owner.id);

    const ids = { a: randomUUID(), b: randomUUID(), stranger: randomUUID() };
    for (const [id, projectId, deviceId] of [
      [ids.a, projectA.id, box.id],
      [ids.b, projectB.id, box.id],
      [ids.stranger, projectC.id, other.id],
    ] as const) {
      await harness.db.execute(sql`
        INSERT INTO runners (id, project_id, device_id, name, type, host, status, last_seen_at)
        VALUES (${id}, ${projectId}, ${deviceId}, 'box', 'claude-code', 'device', 'online', now())
      `);
    }
    return { ...ids, projectA: projectA.id };
  }

  async function healthOf(runnerId: string): Promise<HealthRow> {
    const rows = (await harness.db.execute(sql`
      SELECT id, limit_reason, limit_detail, last_error FROM runners WHERE id = ${runnerId}
    `)) as unknown as HealthRow[];
    return rows[0] as HealthRow;
  }

  it('stamps an auth death on the sibling binding that never ran the job', async () => {
    const s = await seedTwoBindings();

    await mods.stampRunnerLimit(s.a, s.projectA, {
      reason: 'auth',
      until: null,
      detail: 'OAuth token has expired',
    });

    expect((await healthOf(s.b)).limit_reason).toBe('auth');
    expect((await healthOf(s.b)).limit_detail).toBe('OAuth token has expired');
  });

  it('leaves another device alone', async () => {
    const s = await seedTwoBindings();

    await mods.stampRunnerLimit(s.a, s.projectA, {
      reason: 'rate_limit',
      until: new Date(Date.now() + 3_600_000),
      detail: 'rate limited',
    });

    expect((await healthOf(s.stranger)).limit_reason).toBeNull();
  });

  // cm:guard the lastError mirror must NOT travel: attributeFailureToRunner and the adapter-failure path write that column with per-BINDING faults (a missing repo path on one project), so copying this text sideways would overwrite a real fault with a guess
  it('mirrors the detail into lastError only on the binding that failed', async () => {
    const s = await seedTwoBindings();

    await mods.stampRunnerLimit(s.a, s.projectA, {
      reason: 'auth',
      until: null,
      detail: 'OAuth token has expired',
    });

    expect((await healthOf(s.a)).last_error).toBe('OAuth token has expired');
    expect((await healthOf(s.b)).last_error).toBeNull();
  });

  // cm:guard seed the sibling's limit with SQL, never by calling the stamp: routed through the stamp this assertion passes when NEITHER half travels, which is the exact state it exists to catch
  it('clears the sibling too, so one success un-sticks the whole box', async () => {
    const s = await seedTwoBindings();
    await harness.db.execute(sql`
      UPDATE runners SET limit_reason = 'auth', limit_detail = 'OAuth token has expired'
      WHERE id IN (${s.a}, ${s.b})
    `);

    await mods.clearRunnerLimit(s.a, s.projectA);

    expect((await healthOf(s.b)).limit_reason).toBeNull();
    expect((await healthOf(s.a)).limit_reason).toBeNull();
  });

  it('keeps a sibling own lastError while clearing the shared limit', async () => {
    const s = await seedTwoBindings();
    await harness.db.execute(sql`
      UPDATE runners
      SET limit_reason = 'auth', limit_detail = 'OAuth token has expired',
          last_error = CASE WHEN id = ${s.b} THEN 'preflight_failed: folder missing' ELSE last_error END
      WHERE id IN (${s.a}, ${s.b})
    `);

    await mods.clearRunnerLimit(s.a, s.projectA);

    expect((await healthOf(s.b)).last_error).toBe('preflight_failed: folder missing');
  });
});
