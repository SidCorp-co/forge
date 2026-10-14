/**
 * ISS-1319 — a release batch a box took and then went quiet on does not hold its project for ever.
 * The guard that refuses a second batch reads the run's status alone, so a batch whose runner died
 * mid-work read `running` for as long as nobody aborted it, and the one sweep that looked at jobs
 * only took those no box had picked up.
 *
 * Integration because every proposition is about rows under real constraints: which rows a pass
 * selects, what the guard answers before and after it, and which ones it must leave alone.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let mods: {
  recoverSilentReleaseBatches: typeof import('../../src/release-batch/silent-recovery.js').recoverSilentReleaseBatches;
  openAttempt: typeof import('../../src/release-batch/ledger.js').openAttempt;
  createReleaseBatch: typeof import('../../src/release-batch/service.js').createReleaseBatch;
  blockersOf: typeof import('../../src/release-batch/blocker-sentences.js').blockersOf;
  BOUND_DEFAULTS: typeof import('../../src/release-batch/bounds.js').BOUND_DEFAULTS;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  await registerIntegrationsForTest();
  mods = {
    recoverSilentReleaseBatches: (await import('../../src/release-batch/silent-recovery.js'))
      .recoverSilentReleaseBatches,
    openAttempt: (await import('../../src/release-batch/ledger.js')).openAttempt,
    createReleaseBatch: (await import('../../src/release-batch/service.js')).createReleaseBatch,
    blockersOf: (await import('../../src/release-batch/blocker-sentences.js')).blockersOf,
    BOUND_DEFAULTS: (await import('../../src/release-batch/bounds.js')).BOUND_DEFAULTS,
  };
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
});

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);
const { declareProduction, seedReleaseRunner, insertIssue, stored, claim, runStatus } = fx;

beforeEach(async () => {
  await declareProduction();
  await seedReleaseRunner();
});

const STALL_MIN = () => mods.BOUND_DEFAULTS.stall / 60_000;
const silent = () => STALL_MIN() + 15;
const recent = () => STALL_MIN() - 15;

/** A box took the batch's job `minutesAgo` minutes ago. */
async function take(jobId: string, minutesAgo: number): Promise<void> {
  await harness.db.execute(sql`
    UPDATE jobs SET status = 'dispatched',
                    dispatched_at = now() - (${minutesAgo}::int * interval '1 minute')
    WHERE id = ${jobId}
  `);
}

/** One ledger row, written `minutesAgo` minutes ago and settled or not. */
async function write(
  runId: string,
  stage: 'verify' | 'promote',
  minutesAgo: number,
  settled: boolean,
): Promise<void> {
  await mods.openAttempt({ runId, stage, idempotencyKey: `${stage}-${minutesAgo}`, commit: 'abc' });
  await harness.db.execute(sql`
    UPDATE release_attempts
       SET started_at = now() - (${minutesAgo}::int * interval '1 minute'),
           settled_at = ${settled ? sql`now() - (${minutesAgo}::int * interval '1 minute')` : null}
     WHERE run_id = ${runId} AND stage = ${stage}
  `);
}

async function refusedBy(ids: string[]): Promise<string[]> {
  const refusal = await mods.createReleaseBatch({ projectId, issueIds: ids, userId: ownerId }).then(
    () => null,
    (err: unknown) => err,
  );
  return mods.blockersOf(refusal).map((b) => b.code);
}

async function wedgesFor(jobId: string): Promise<number> {
  const rows = (await harness.db.execute(sql`
    SELECT count(*)::int AS n FROM notifications
    WHERE type = 'pipeline_wedge' AND resolution_key = ${`wedge:${jobId}`}
  `)) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

async function abortStamp(runId: string): Promise<{ reason: string; by: string } | null> {
  const rows = (await harness.db.execute(sql`
    SELECT metadata -> 'abort' AS stamp FROM pipeline_runs WHERE id = ${runId}
  `)) as unknown as Array<{ stamp: { reason: string; by: string } | null }>;
  return rows[0]?.stamp ?? null;
}

async function transitionReasons(issueId: string): Promise<string[]> {
  const rows = (await harness.db.execute(sql`
    SELECT reason FROM kernel_transitions
    WHERE entity = 'issue' AND entity_id = ${issueId} AND to_status = 'awaiting_release'
  `)) as unknown as Array<{ reason: string | null }>;
  return rows.map((r) => r.reason ?? '');
}

/** The batch every case starts from: two issues claimed, the job queued, nothing taken yet. */
async function batch(): Promise<{ a: string; b: string; runId: string; jobId: string }> {
  const a = await insertIssue();
  const b = await insertIssue();
  const { runId, jobId } = await claim([a, b], { look: false });
  return { a, b, runId, jobId };
}

describe('a batch whose box took the job and then went silent', () => {
  it('is refused a successor before the pass, and recovered and admitted after it', async () => {
    const { a, b, runId, jobId } = await batch();
    await take(jobId, silent());
    const next = await insertIssue();
    expect(await refusedBy([next])).toContain('BATCH_IN_FLIGHT');
    expect(await runStatus(runId)).toBe('running');

    expect(await mods.recoverSilentReleaseBatches()).toEqual({ recovered: 1, held: 0 });

    expect(await runStatus(runId)).toBe('cancelled');
    for (const id of [a, b]) {
      const after = await stored(id);
      expect(after.status).toBe('awaiting_release');
      expect(after.claim).toBeNull();
    }
    expect(await refusedBy([next])).toEqual([]);
    expect((await stored(next)).status).toBe('releasing');
  });

  it('names its reason on the run, on each issue it moves, and on a surface', async () => {
    const { a, runId, jobId } = await batch();
    await take(jobId, silent());

    await mods.recoverSilentReleaseBatches();

    const stamp = await abortStamp(runId);
    expect(stamp?.reason).toContain(`${silent()} minutes`);
    expect(stamp?.reason).toContain('nothing is running it');
    expect(stamp?.by).toBe('');
    const reasons = await transitionReasons(a);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('nothing is running it');
    expect(await wedgesFor(jobId)).toBe(1);
  });

  it('finds nothing to do on a second pass', async () => {
    const { jobId } = await batch();
    await take(jobId, silent());
    await mods.recoverSilentReleaseBatches();

    expect(await mods.recoverSilentReleaseBatches()).toEqual({ recovered: 0, held: 0 });
    expect(await wedgesFor(jobId)).toBe(1);
  });

  it('is recovered where it died before promoting, after earlier ledger writes', async () => {
    const { runId, jobId } = await batch();
    await take(jobId, silent() * 2);
    await write(runId, 'verify', silent(), true);

    expect(await mods.recoverSilentReleaseBatches()).toEqual({ recovered: 1, held: 0 });
    expect(await runStatus(runId)).toBe('cancelled');
  });

  it('holds the roster at releasing where it declared a promotion and never settled it', async () => {
    const { a, b, runId, jobId } = await batch();
    await take(jobId, silent() * 2);
    await write(runId, 'promote', silent(), false);

    expect(await mods.recoverSilentReleaseBatches()).toEqual({ recovered: 1, held: 1 });

    expect(await runStatus(runId)).toBe('cancelled');
    for (const id of [a, b]) {
      const after = await stored(id);
      expect(after.status).toBe('releasing');
      expect(after.claim).toBe(runId);
    }
    expect(await abortStamp(runId)).toMatchObject({ reason: expect.stringContaining('minutes') });
  });
});

describe('the state a person reads', () => {
  it('calls a silent taken batch holding on the stall bound, as the pass does, and a live one not', async () => {
    const { readReleaseRunState } = await import('../../src/release-batch/state.js');
    const { runId, jobId } = await batch();

    await take(jobId, recent());
    expect((await readReleaseRunState(runId))?.bounds).toMatchObject({
      holding: false,
      crossedNames: [],
    });

    await take(jobId, silent());
    expect((await readReleaseRunState(runId))?.bounds).toMatchObject({
      holding: true,
      crossedNames: ['stall'],
    });
  });
});

describe('what the pass must leave alone', () => {
  async function untouched(runId: string, a: string): Promise<void> {
    expect(await runStatus(runId)).toBe('running');
    const after = await stored(a);
    expect(after.status).toBe('releasing');
    expect(after.claim).toBe(runId);
    expect(await abortStamp(runId)).toBeNull();
  }

  it('a batch whose job was taken inside the bound', async () => {
    const { a, runId, jobId } = await batch();
    await take(jobId, recent());

    expect(await mods.recoverSilentReleaseBatches()).toEqual({ recovered: 0, held: 0 });

    await untouched(runId, a);
    expect(await refusedBy([await insertIssue()])).toContain('BATCH_IN_FLIGHT');
  });

  it('a batch whose ledger was written to inside the bound', async () => {
    const { a, runId, jobId } = await batch();
    await take(jobId, silent() * 2);
    await write(runId, 'verify', recent(), false);

    expect(await mods.recoverSilentReleaseBatches()).toEqual({ recovered: 0, held: 0 });

    await untouched(runId, a);
  });

  it('a batch whose promotion settled, which is a person to read', async () => {
    const { a, runId, jobId } = await batch();
    await take(jobId, silent() * 2);
    await write(runId, 'promote', silent(), true);

    expect(await mods.recoverSilentReleaseBatches()).toEqual({ recovered: 0, held: 0 });

    await untouched(runId, a);
  });

  it('a batch whose job no box took, which is the other sweep', async () => {
    const { a, runId, jobId } = await batch();
    await harness.db.execute(sql`
      UPDATE jobs SET queued_at = now() - interval '5 hours' WHERE id = ${jobId}
    `);

    expect(await mods.recoverSilentReleaseBatches()).toEqual({ recovered: 0, held: 0 });

    await untouched(runId, a);
  });

  it.each([
    [
      'one a person already aborted',
      sql`jsonb_build_object('abort', jsonb_build_object('roster', 'released'))`,
    ],
    [
      'one carrying a finish record',
      sql`jsonb_build_object('finish', jsonb_build_object('state', 'failed'))`,
    ],
  ])('%s', async (_name, patch) => {
    const { runId, jobId } = await batch();
    await take(jobId, silent() * 2);
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET metadata = metadata || ${patch} WHERE id = ${runId}
    `);

    expect(await mods.recoverSilentReleaseBatches()).toEqual({ recovered: 0, held: 0 });

    expect(await runStatus(runId)).toBe('running');
  });

  it('a batch that is paused', async () => {
    const { a, runId, jobId } = await batch();
    await take(jobId, silent() * 2);
    await harness.db.execute(sql`UPDATE pipeline_runs SET status = 'paused' WHERE id = ${runId}`);

    expect(await mods.recoverSilentReleaseBatches()).toEqual({ recovered: 0, held: 0 });

    expect(await runStatus(runId)).toBe('paused');
    expect((await stored(a)).status).toBe('releasing');
  });
});
