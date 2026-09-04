/**
 * The empty-pool path, against real Postgres.
 *
 * `nextRotation`'s "no usable device" branch had no test at all, which is how
 * it shipped advancing the round for a sweep that never happened. The unit
 * suite pins the decision against a mocked device list; this file pins it
 * against the REAL `onlineCapableDeviceIds` query, because "the pool is empty"
 * is that query's verdict and nothing else's — a mock can assert the branch but
 * never that the branch is entered for the right reason.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const emitWedgeMock = vi.fn(async (..._a: unknown[]) => undefined);
const resolveWedgeMock = vi.fn(async (..._a: unknown[]) => 0);
vi.mock('../../src/pipeline/wedge.js', () => ({
  capacityWedgeEntityId: (p: string, s: string) => `capacity:${p}:${s}`,
  emitPipelineWedge: (...a: unknown[]) => emitWedgeMock(...a),
  resolvePipelineWedge: (...a: unknown[]) => resolveWedgeMock(...a),
}));

vi.mock('../../src/jobs/enqueue.js', () => ({
  enqueueJob: async () => undefined,
  enqueueReconcileJob: async () => undefined,
}));

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  scheduleAutoRetryWithVerify: typeof import('../../src/jobs/retry.js').scheduleAutoRetryWithVerify;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  CAPACITY_DEFER_CEILING_MS: typeof import('../../src/jobs/retry.js').CAPACITY_DEFER_CEILING_MS;
};

describe('capacity deferral E2E', () => {
  let harness: TestDatabase;
  let mods: Mods;
  let projectId: string;
  let ownerId: string;
  let deviceId: string;
  let runnerId: string;

  const SPEND_LIMIT_ERROR = "You've hit your org's monthly spend limit";

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

    mods = (await import('../../src/jobs/retry.js')) as unknown as Mods;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    emitWedgeMock.mockClear();
    resolveWedgeMock.mockClear();
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    const project = await createTestProject(harness.db, owner.id);
    projectId = project.id;
    const device = await createTestDevice(harness.db, owner.id, { status: 'online' });
    deviceId = device.id;
    runnerId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, capabilities, status, last_seen_at)
      VALUES (${runnerId}, ${projectId}, 'claude-code', ${deviceId},
              ${`runner-${runnerId.slice(0, 8)}`}, '{}'::jsonb, 'online', now())
    `);
  });

  /** The one runner hits an account limit — the pool's only device goes unusable. */
  async function rateLimitTheFleet(): Promise<void> {
    await harness.db.execute(sql`
      UPDATE runners SET limit_reason = 'usage_limit',
                         rate_limited_until = now() + interval '6 hours'
      WHERE id = ${runnerId}
    `);
  }

  async function failedJob(rotation?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, NULL, 'system', 'running', now())
    `);
    const id = randomUUID();
    const payload = rotation ? { _autoRetry: rotation } : {};
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, device_id, runner_id, created_by, type,
                        status, payload, error, failure_kind, failure_action, attempts, finished_at)
      VALUES (${id}, ${projectId}, ${runId}, ${deviceId}, ${runnerId}, ${ownerId}, 'code',
              'failed', ${JSON.stringify(payload)}::jsonb, ${SPEND_LIMIT_ERROR},
              'transient-cc', 'failover', 1, now())
    `);
    const [row] = await harness.db.execute<Record<string, unknown>>(
      sql`SELECT * FROM jobs WHERE id = ${id}`,
    );
    // cm:guard the camelCase overlay is required, not cosmetic — a raw `db.execute` returns snake_case keys, so handing the row straight to the engine leaves `projectId`/`deviceId` undefined and the pool read then scopes to project `undefined`, which returns an empty set and makes EVERY case in this file look like a capacity outage
    return {
      ...row,
      projectId,
      pipelineRunId: runId,
      deviceId,
      runnerId,
      createdBy: ownerId,
      issueId: null,
      agentSessionId: null,
      failureKind: 'transient-cc',
      failureAction: 'failover',
      modelTier: null,
      payload,
      type: 'code',
      attempts: 1,
    };
  }

  // cm:guard the assertion is on the ROUND, not on whether a retry happened — a retry happens either way, and the round is the only thing that separates "waiting for capacity" from "burning the budget that decides which hold reason this job ends on"
  it('defers without spending a round when every runner is rate-limited', async () => {
    await rateLimitTheFleet();
    const job = await failedJob({ round: 4, target: deviceId, tries: 1, done: ['other-device'] });

    const res = await mods.scheduleAutoRetryWithVerify(job as never, 'spend-limit');

    expect(res.scheduled).toBe(true);
    const [clone] = await harness.db.execute<{ payload: Record<string, unknown> }>(
      sql`SELECT payload FROM jobs WHERE retry_of = ${job.id as string}`,
    );
    const rotation = clone?.payload._autoRetry as {
      round: number;
      target: string;
      done: string[];
      deferredSince: string;
    };
    expect(rotation.round).toBe(4);
    expect(rotation.done).toEqual(['other-device']);
    expect(rotation.target).toBe(deviceId);
    expect(rotation.deferredSince).toBeTruthy();
  });

  // cm:guard `all_devices_exhausted` is the POINT of the ceiling — it is condition-checked in jobs/hold.ts, so the job releases itself when a runner frees. Landing on `retry_rounds_exhausted` here instead is what used to require a human with no button to press.
  it('gives up with the self-clearing reason once the ceiling passes', async () => {
    await rateLimitTheFleet();
    const stale = new Date(Date.now() - mods.CAPACITY_DEFER_CEILING_MS - 5_000).toISOString();
    const job = await failedJob({
      round: 1,
      target: deviceId,
      tries: 3,
      done: [],
      deferredSince: stale,
    });

    const res = await mods.scheduleAutoRetryWithVerify(job as never, 'spend-limit');

    expect(res.scheduled).toBe(false);
    expect(res.reason).toBe('all_devices_exhausted');
    const rows = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM jobs WHERE retry_of = ${job.id as string}`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('rotates normally and clears the capacity notification while a runner is usable', async () => {
    const job = await failedJob();

    const res = await mods.scheduleAutoRetryWithVerify(job as never, 'spend-limit');

    expect(res.scheduled).toBe(true);
    expect(emitWedgeMock).not.toHaveBeenCalled();
    expect(resolveWedgeMock).toHaveBeenCalledWith(`capacity:${projectId}:all`);
  });

  // cm:guard an offline fleet and a rate-limited one must reach the SAME deferral — both mean "nothing can take this work", and only the notification text should differ. A branch that treats offline as retryable spends the budget against boxes dispatch will refuse.
  it('defers the same way when the fleet is offline rather than limited', async () => {
    await harness.db.execute(sql`UPDATE runners SET status = 'offline' WHERE id = ${runnerId}`);
    await harness.db.execute(sql`UPDATE devices SET status = 'offline' WHERE id = ${deviceId}`);
    const job = await failedJob({ round: 2, target: deviceId, tries: 3, done: [] });

    const res = await mods.scheduleAutoRetryWithVerify(job as never, 'spend-limit');

    expect(res.scheduled).toBe(true);
    const [clone] = await harness.db.execute<{ payload: Record<string, unknown> }>(
      sql`SELECT payload FROM jobs WHERE retry_of = ${job.id as string}`,
    );
    expect((clone?.payload._autoRetry as { round: number }).round).toBe(2);
    expect(emitWedgeMock).toHaveBeenCalledTimes(1);
    const ev = emitWedgeMock.mock.calls[0]?.[0] as Record<string, string>;
    expect(ev.reason).toBe('no capable device is online');
  });
});
