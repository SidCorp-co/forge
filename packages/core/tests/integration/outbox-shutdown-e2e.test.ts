/**
 * ISS-830 — a graceful shutdown must not abandon a committed outbox claim.
 *
 * Since ISS-678 the worker claims a batch by committing `claimed_at = now()`
 * up front. Only the emitting tick clears it: success stamps `processed_at`,
 * failure sets `claimed_at = NULL`. Abandon the tick and the rows stay claimed
 * until `CLAIM_LEASE_MS` (120s) expires, so a restart landing mid-drain adds up
 * to two minutes of latency to whatever transitions were in that batch.
 *
 * What is asserted is the property, not the call: after `stopOutboxWorker()`
 * resolves, no row is left claimed-but-unprocessed.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  drainOutboxOnce: typeof import('../../src/pipeline/outbox-worker.js').drainOutboxOnce;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  stopOutboxWorker: typeof import('../../src/pipeline/outbox-worker.js').stopOutboxWorker;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  registerOutboxWorker: typeof import('../../src/pipeline/outbox-worker.js').registerOutboxWorker;
};

describe('outbox graceful shutdown (ISS-830)', () => {
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

    mods = (await import('../../src/pipeline/outbox-worker.js')) as unknown as Mods;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seedRows(n: number) {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, created_by_id)
      VALUES (${issueId}, ${project.id}, 'outbox probe', 'open', ${owner.id})
    `);
    for (let i = 0; i < n; i++) {
      await harness.db.execute(sql`
        INSERT INTO pipeline_outbox (id, issue_id, project_id, from_status, to_status,
                                     actor_type, reason, created_at)
        VALUES (${randomUUID()}, ${issueId}, ${project.id}, 'open', 'confirmed',
                'system', 'iss-830 probe', now())
      `);
    }
    return { issueId, projectId: project.id };
  }

  async function counts() {
    const r = (await harness.db.execute(sql`
      SELECT
        count(*) FILTER (WHERE processed_at IS NULL AND claimed_at IS NOT NULL)::int AS stranded,
        count(*) FILTER (WHERE processed_at IS NULL)::int AS unprocessed,
        count(*)::int AS total
      FROM pipeline_outbox
    `)) as unknown as { stranded: number; unprocessed: number; total: number }[];
    const row = r[0];
    return {
      stranded: Number(row?.stranded ?? 0),
      unprocessed: Number(row?.unprocessed ?? 0),
      total: Number(row?.total ?? 0),
    };
  }

  // cm:guard the property ISS-830 is about — a claim is a commitment the shutdown path must settle. If this fails, a rolling restart silently adds up to CLAIM_LEASE_MS of dispatch latency, which no alarm covers because delivery still succeeds eventually.
  it('leaves no row claimed-but-unprocessed once the worker has stopped', async () => {
    await seedRows(3);
    mods.registerOutboxWorker();
    await mods.stopOutboxWorker();
    const c = await counts();
    expect(c.total).toBe(3);
    expect(c.stranded).toBe(0);
  });

  it('a completed drain settles every row it claimed', async () => {
    await seedRows(2);
    await mods.drainOutboxOnce();
    await expect(counts()).resolves.toMatchObject({ stranded: 0 });
  });

  it('is safe to stop a worker that was never started', async () => {
    await seedRows(1);
    await expect(mods.stopOutboxWorker()).resolves.toBeUndefined();
    await expect(counts()).resolves.toMatchObject({ stranded: 0, total: 1 });
  });

  it('is idempotent — stopping twice neither throws nor strands anything', async () => {
    await seedRows(2);
    mods.registerOutboxWorker();
    await mods.stopOutboxWorker();
    await mods.stopOutboxWorker();
    await expect(counts()).resolves.toMatchObject({ stranded: 0 });
  });

  it('does nothing to an empty outbox', async () => {
    mods.registerOutboxWorker();
    await mods.stopOutboxWorker();
    await expect(counts()).resolves.toMatchObject({ total: 0, stranded: 0 });
  });
});
