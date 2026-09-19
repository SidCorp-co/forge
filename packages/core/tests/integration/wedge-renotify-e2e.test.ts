/**
 * The wedge notification loop, against real Postgres.
 *
 * Measured on forge-beta 2026-08-14: 721 `pipeline_wedge` rows, none resolved.
 * The dedupe matched `read = false`, so opening one re-armed it and the next
 * monitor pass wrote another — read, re-emit, read. Nothing here asserts a
 * notification exists; every case asserts a COUNT after a repeat, because the
 * count is the whole defect.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  emitPipelineWedge: typeof import('../../src/pipeline/wedge.js').emitPipelineWedge;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  resolvePipelineWedge: typeof import('../../src/pipeline/wedge.js').resolvePipelineWedge;
};

describe('emitPipelineWedge dedup: one record per unresolved entity', () => {
  let harness: TestDatabase;
  let mods: Mods;
  let projectId: string;
  let entityId: string;

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

    mods = (await import('../../src/pipeline/wedge.js')) as unknown as Mods;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    projectId = project.id;
    entityId = randomUUID();
  });

  async function emit(): Promise<void> {
    await mods.emitPipelineWedge({
      projectId,
      issueId: null,
      hop: 'dispatch',
      entity: 'job',
      entityId,
      reason: 'held_over_6h:non_retryable_terminal',
      action: 'Fix the cause, then cancel the step.',
    });
  }

  async function countWedges(): Promise<number> {
    const rows = (await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM notifications WHERE type = 'pipeline_wedge'`,
    )) as unknown as { n: number }[];
    return rows[0]?.n ?? 0;
  }

  it('writes one row for the first emit and suppresses an immediate repeat', async () => {
    await emit();
    await emit();
    await emit();
    expect(await countWedges()).toBe(1);
  });

  it('stays suppressed after the operator reads it', async () => {
    await emit();
    await harness.db.execute(sql`UPDATE notification_deliveries SET read_at = now()`);
    await emit();
    expect(await countWedges()).toBe(1);
  });

  it('writes no second record however old the first one is', async () => {
    await emit();
    await harness.db.execute(
      sql`UPDATE notifications SET created_at = now() - interval '30 days'
                                 , last_seen_at = now() - interval '30 days'`,
    );
    await emit();
    expect(await countWedges()).toBe(1);
  });

  it('re-notifies immediately once the wedge is resolved — a NEW occurrence is news', async () => {
    await emit();
    expect(await mods.resolvePipelineWedge(entityId)).toBe(1);

    const resolved = (await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM notifications WHERE resolved_at IS NOT NULL`,
    )) as unknown as { n: number }[];
    expect(resolved[0]?.n).toBe(1);

    await emit();
    expect(await countWedges()).toBe(2);
  });
});
