/**
 * ISS-806 — a box-scoped failure must land on the box.
 *
 * The unit tests cover which strings count. This covers the part that actually
 * broke: the write reaching `runners.last_error` for the right runner and no
 * other. On pixelight three boxes failed every push-bearing job for three days
 * with `lastError: null`, so attribution reads as fleet health here, not as a
 * string predicate.
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
  attributeFailureToRunner: typeof import('../../src/runners/attribute-failure.js').attributeFailureToRunner;
};

const PREFLIGHT =
  'preflight_failed: push_credentials: git@github.com: Permission denied (publickey).';

describe('runner failure attribution E2E (ISS-806)', () => {
  let harness: TestDatabase;
  let mods: Mods;

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

    mods = (await import('../../src/runners/attribute-failure.js')) as unknown as Mods;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seedRunner() {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const device = await createTestDevice(harness.db, owner.id);
    const runnerId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, name, type, host, status, last_seen_at)
      VALUES (${runnerId}, ${project.id}, ${device.id}, 'box', 'claude-code', 'device', 'online', now())
    `);
    return { runnerId, projectId: project.id };
  }

  async function lastErrorOf(runnerId: string): Promise<string | null> {
    const rows = (await harness.db.execute(
      sql`SELECT last_error FROM runners WHERE id = ${runnerId}`,
    )) as unknown as { last_error: string | null }[];
    return rows[0]?.last_error ?? null;
  }

  // cm:guard the whole issue in one assertion — before this, a box failing 100% of push-bearing jobs reported last_error NULL and read as healthy
  it('stamps last_error on the box that failed its own preflight', async () => {
    const s = await seedRunner();
    expect(await lastErrorOf(s.runnerId)).toBeNull();

    await expect(mods.attributeFailureToRunner(s.runnerId, PREFLIGHT)).resolves.toBe(true);
    expect(await lastErrorOf(s.runnerId)).toContain('Permission denied');
  });

  it('leaves a healthy box alone when another box fails', async () => {
    const sick = await seedRunner();
    const healthy = await seedRunner();
    await mods.attributeFailureToRunner(sick.runnerId, PREFLIGHT);
    expect(await lastErrorOf(sick.runnerId)).not.toBeNull();
    expect(await lastErrorOf(healthy.runnerId)).toBeNull();
  });

  it('does not blame the box for a provider quota failure', async () => {
    const s = await seedRunner();
    await expect(
      mods.attributeFailureToRunner(
        s.runnerId,
        "[RESULT_ERROR] success: You've hit your org's monthly spend limit",
      ),
    ).resolves.toBe(false);
    expect(await lastErrorOf(s.runnerId)).toBeNull();
  });

  it('overwrites a previous stamp so the field shows the current fault', async () => {
    const s = await seedRunner();
    await mods.attributeFailureToRunner(s.runnerId, 'preflight_failed: work_tree: dirty');
    await mods.attributeFailureToRunner(s.runnerId, PREFLIGHT);
    expect(await lastErrorOf(s.runnerId)).toContain('Permission denied');
  });

  it('is a no-op, not a throw, when the job had no runner', async () => {
    await expect(mods.attributeFailureToRunner(null, PREFLIGHT)).resolves.toBe(false);
  });

  it('survives an unknown runner id without breaking the failure path it observes', async () => {
    await expect(mods.attributeFailureToRunner(randomUUID(), PREFLIGHT)).resolves.toBe(true);
  });
});
