/**
 * The quarantine ladder, against real Postgres.
 *
 * A flat TTL made quarantine a metronome rather than a brake: expiry hands a
 * permanently-broken box one more probe, forever. Measured 2026-08-14 —
 * ubuntu1/Anhome took one job an hour for 8 hours (21:46→02:04), every one
 * dying on the same `preflight_failed: work_tree`, and SidPeak did the same on
 * `hooks_path`. Both conditions needed a human; neither was a function of time.
 *
 * Nothing here asserts that quarantine got SET — the old test did, and passed
 * throughout. Every case measures the interval instead.
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
  maybeQuarantineRunner: typeof import('../../src/runners/quarantine.js').maybeQuarantineRunner;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  RUNNER_QUARANTINE_STREAK: typeof import('../../src/runners/quarantine.js').RUNNER_QUARANTINE_STREAK;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  RUNNER_QUARANTINE_TTL_MS: typeof import('../../src/runners/quarantine.js').RUNNER_QUARANTINE_TTL_MS;
  quarantineTtlMs: typeof import('../../src/runners/quarantine.js').quarantineTtlMs;
};

describe('runner quarantine backoff E2E', () => {
  let harness: TestDatabase;
  let mods: Mods;
  let projectId: string;
  let runnerId: string;

  const CHECK = 'work_tree';
  const ERROR = `preflight_failed: ${CHECK}: not a git repository`;

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

    mods = (await import('../../src/runners/quarantine.js')) as unknown as Mods;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  // cm:guard every terminal row needs a DISTINCT finished_at — the streak walk orders by finished_at DESC, so two rows sharing a timestamp make which of them is "leading" a coin flip, and the `done` row deciding that flip is what would flake the reset case
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 7, 14) + ++tick * 60_000);

  beforeEach(async () => {
    await truncateAll(harness.db);
    tick = 0;
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    projectId = project.id;
    const device = await createTestDevice(harness.db, owner.id, { status: 'online' });
    runnerId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, capabilities, status, last_seen_at)
      VALUES (
        ${runnerId}, ${projectId}, 'claude-code', ${device.id},
        ${`runner-${runnerId.slice(0, 8)}`}, '{}'::jsonb, 'online', now()
      )
    `);
  });

  async function openRun(): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${id}, ${projectId}, NULL, 'system', 'running', now())
    `);
    return id;
  }

  async function insertJob(args: {
    status?: string;
    error?: string | null;
    finishedAt?: Date | null;
  }): Promise<string> {
    const id = randomUUID();
    const runId = await openRun();
    await harness.db.execute(sql`
      INSERT INTO jobs (
        id, project_id, pipeline_run_id, runner_id, created_by, type, status,
        payload, error, finished_at
      )
      VALUES (
        ${id}, ${projectId}, ${runId}, ${runnerId},
        (SELECT created_by FROM projects WHERE id = ${projectId}),
        'code', ${args.status ?? 'queued'}, '{}'::jsonb, ${args.error ?? null},
        ${args.finishedAt ? args.finishedAt.toISOString() : null}
      )
    `);
    return id;
  }

  const addTerminal = (status: 'failed' | 'done') =>
    insertJob({ status, error: status === 'failed' ? ERROR : null, finishedAt: stamp() });

  /** Trip quarantine once and return how long it bought, in ms. */
  async function tripAndMeasure(): Promise<number> {
    const currentJobId = await insertJob({});
    const before = Date.now();
    expect(await mods.maybeQuarantineRunner(runnerId, projectId, currentJobId, ERROR)).toBe(true);
    const [row] = await harness.db.execute<{ quarantined_until: string }>(
      sql`SELECT quarantined_until FROM runners WHERE id = ${runnerId}`,
    );
    // cm:why finalizing the trip's own job is what makes the NEXT call a re-trip rather than a repeat of the first — maybeQuarantineRunner excludes currentJobId, so an unfinalized row is invisible to the streak walk
    await harness.db.execute(sql`
      UPDATE jobs SET status = 'failed', error = ${ERROR},
                      finished_at = ${stamp().toISOString()}
      WHERE id = ${currentJobId}
    `);
    return new Date(row?.quarantined_until ?? 0).getTime() - before;
  }

  async function seedStreakToTheEdgeOfTripping(): Promise<void> {
    for (let i = 0; i < mods.RUNNER_QUARANTINE_STREAK - 1; i++) await addTerminal('failed');
  }

  // cm:guard the SECOND trip must buy strictly MORE quiet than the first — this is the entire fix. A test that only asserts quarantine was set passes on the flat TTL that produced the 8-hour ubuntu1 loop.
  it('escalates on each consecutive re-trip of the same check', async () => {
    await seedStreakToTheEdgeOfTripping();
    const base = mods.RUNNER_QUARANTINE_TTL_MS;

    const first = await tripAndMeasure();
    const second = await tripAndMeasure();
    const third = await tripAndMeasure();

    expect(first).toBeGreaterThanOrEqual(base * 0.9);
    expect(first).toBeLessThan(base * 1.5);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(third).toBeGreaterThanOrEqual(base * 4 * 0.9);
  });

  // cm:guard one SUCCESS must reset the rung — the job history is the only strike counter, which is what keeps `clearRunnerQuarantine` from having to know the ladder exists. A counter column would go stale here instead.
  it('drops back to the first rung after a single success', async () => {
    await seedStreakToTheEdgeOfTripping();
    await tripAndMeasure();
    await tripAndMeasure();

    await addTerminal('done');
    await seedStreakToTheEdgeOfTripping();

    const afterSuccess = await tripAndMeasure();
    expect(afterSuccess).toBeLessThan(mods.RUNNER_QUARANTINE_TTL_MS * 1.5);
  });

  // cm:guard the ladder must FLATTEN, never keep doubling — an unbounded ladder eventually parks a repaired box for weeks, which is a wedge dressed as a brake
  it('holds at the top rung instead of doubling forever', async () => {
    expect(mods.quarantineTtlMs(99)).toBe(mods.quarantineTtlMs(4));
    expect(mods.quarantineTtlMs(4)).toBe(mods.RUNNER_QUARANTINE_TTL_MS * 24);
    expect(mods.quarantineTtlMs(-1)).toBe(mods.RUNNER_QUARANTINE_TTL_MS);
  });
});
