import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

vi.mock('../../src/pipeline/wedge.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  emitPipelineWedge: async () => undefined,
  resolvePipelineWedge: async () => 0,
}));
vi.mock('../../src/jobs/finalize-failure.js', () => ({
  finalizeFailedJob: async () => ({ scheduled: false, reason: 'mocked-in-test' }),
}));

const KILL_GRACE_MS = 90_000;
/** `RESULT_QUIET_MINUTES` — `reapConcludedRuns` will not close a run whose last child finished
 *  inside this window, so a sweep that means to judge these rows has to stand past it. Pinning it
 *  on the caller's `now` is what `selectConcluded`'s own guard says the parameter is for. */
const PAST_THE_QUIET_WINDOW = () => new Date(Date.now() + 61 * 60_000);

describe('a bounded job-axis reaper crosses neither terminal invariant (ISS-1021)', () => {
  let harness: TestDatabase;
  let loop: typeof import('../../src/jobs/loop-monitor.js');
  let concluded: typeof import('../../src/pipeline/runs-concluded.js');
  let runs: typeof import('../../src/pipeline/runs.js');
  let projectId: string;
  let ownerId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';

    loop = await import('../../src/jobs/loop-monitor.js');
    concluded = await import('../../src/pipeline/runs-concluded.js');
    runs = await import('../../src/pipeline/runs.js');
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    projectId = (await createTestProject(harness.db, owner.id)).id;
  });

  /** A run and `count` ack-miss candidates under it, oldest dispatch first, no device to answer. */
  async function seedRunWithCandidates(count: number): Promise<string> {
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, 'interactive', 'running', now() - interval '6 hours')
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, type, status, payload,
                        created_by, queued_at, dispatched_at)
      SELECT gen_random_uuid(), ${projectId}, ${runId}, 'plan', 'dispatched', '{}'::jsonb,
             ${ownerId}, now() - interval '6 hours',
             now() - interval '5 hours' + make_interval(secs => g)
      FROM generate_series(1, ${count}) AS g
    `);
    return runId;
  }

  async function countWhere(clause: ReturnType<typeof sql>): Promise<number> {
    const rows = await harness.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM jobs WHERE ${clause}`,
    );
    return Number(rows[0]?.n ?? '-1');
  }

  /** Age every open kill episode past the grace, which is what one more minute of wall clock does. */
  async function elapseTheGrace(): Promise<void> {
    await harness.db.execute(sql`
      UPDATE jobs
         SET kill_requested_at = kill_requested_at
                               - make_interval(secs => ${(KILL_GRACE_MS / 1000) * 1.5})
       WHERE kill_requested_at IS NOT NULL AND status = 'dispatched'
    `);
  }

  it('reads 200 of 205 candidates in one tick and leaves the rest untouched', async () => {
    await seedRunWithCandidates(205);

    const first = await loop.reapAckMisses(new Date());

    // The gate's first phase: 200 rows asked to stop, 5 not yet looked at.
    expect(first.killRequested).toBe(200);
    expect(await countWhere(sql`kill_requested_at IS NOT NULL`)).toBe(200);
    expect(await countWhere(sql`kill_requested_at IS NULL`)).toBe(5);
  }, 120_000);

  it('reaps the candidates the truncated tick never read, once the page ahead has drained', async () => {
    await seedRunWithCandidates(205);

    await loop.reapAckMisses(new Date());
    // A tick inside the grace reads the same page again and writes nothing new — the bound is
    // oldest-first, and a row under a live kill request has not left the candidate set yet.
    const held = await loop.reapAckMisses(new Date());
    expect(held.awaitingKill).toBe(200);
    expect(await countWhere(sql`kill_requested_at IS NULL`)).toBe(5);

    await elapseTheGrace();
    const drained = await loop.reapAckMisses(new Date());
    expect(drained.reaped).toBe(200);

    // Only now does the page ahead move, and the five tail rows are reached.
    const tail = await loop.reapAckMisses(new Date());
    expect(tail.killRequested).toBe(5);
    await elapseTheGrace();
    expect((await loop.reapAckMisses(new Date())).reaped).toBe(5);

    expect(await countWhere(sql`status = 'dispatched'`)).toBe(0);
    expect(await countWhere(sql`status = 'failed'`)).toBe(205);
  }, 300_000);

  it('leaves no child job non-terminal under a terminal run when a tick fills its bound', async () => {
    const runId = await seedRunWithCandidates(205);

    await loop.reapAckMisses(new Date());
    // The forward invariant, measured at the worst moment the bound can create: 200 rows mid-gate
    // and 5 never read, and the run closes underneath all of them.
    await runs.closeRun(runId, 'cancelled');

    const stranded = await countWhere(
      sql`pipeline_run_id = ${runId} AND status NOT IN ('done', 'failed', 'cancelled')`,
    );
    expect(stranded).toBe(0);
  }, 120_000);

  it('closes a run on the outcome of the last child a later page reaped', async () => {
    const runId = await seedRunWithCandidates(205);

    await loop.reapAckMisses(new Date());
    await elapseTheGrace();
    await loop.reapAckMisses(new Date());

    // 200 children terminal, 5 still dispatched: the run is NOT concluded, and a sweep that closed
    // it here would be the orphan the bound must not create.
    expect((await concluded.reapConcludedRuns(PAST_THE_QUIET_WINDOW())).reaped).toBe(0);
    expect(await runStatus(runId)).toBe('running');

    await loop.reapAckMisses(new Date());
    await elapseTheGrace();
    await loop.reapAckMisses(new Date());
    expect(await countWhere(sql`pipeline_run_id = ${runId} AND status = 'dispatched'`)).toBe(0);

    // The inverse invariant: the last eligible child was reaped on a later page, and the run takes
    // its outcome from that child rather than from the page that filled the bound.
    expect((await concluded.reapConcludedRuns(PAST_THE_QUIET_WINDOW())).reaped).toBe(1);
    expect(await runStatus(runId)).toBe('failed');
  }, 300_000);

  async function runStatus(runId: string): Promise<string> {
    const rows = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM pipeline_runs WHERE id = ${runId}`,
    );
    return rows[0]?.status ?? 'missing';
  }
});
