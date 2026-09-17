/**
 * ISS-1080 criteria 6-13 — a release batch nothing ever started does not keep
 * its roster.
 *
 * `createReleaseBatch` claims the roster and moves every issue to `releasing`
 * before the job runs, and the liveness it checked was true once, at the cut.
 * When no box takes the job, the only writer that reaches those issues runs on
 * the run going terminal, and nothing made it do that. `pixelight` held one
 * there for 16 hours.
 *
 * Integration because every proposition here is about rows under real
 * constraints: which arm a CAS matches, what a transition is permitted to do to
 * an issue at `releasing`, and whether a second reader finds an empty set. The
 * race in particular has no mocked form — what makes the fence sound is that
 * `startJobForMaster`'s own UPDATE requires `status = 'queued'`, and only
 * Postgres can be asked whether both statements can win.
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
  recoverUnstartedReleaseBatches: typeof import('../../src/release-batch/unstarted-recovery.js').recoverUnstartedReleaseBatches;
  RELEASE_UNSTARTED_DEADLINE_MS: number;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  await registerIntegrationsForTest();
  const m = await import('../../src/release-batch/unstarted-recovery.js');
  mods = {
    recoverUnstartedReleaseBatches: m.recoverUnstartedReleaseBatches,
    RELEASE_UNSTARTED_DEADLINE_MS: m.RELEASE_UNSTARTED_DEADLINE_MS,
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

/** Put the job's wait behind it, so the deadline is the thing under test and not the clock. */
async function ageJob(jobId: string, minutes: number): Promise<void> {
  await harness.db.execute(sql`
    UPDATE jobs SET queued_at = now() - (${minutes}::int * interval '1 minute') WHERE id = ${jobId}
  `);
}

async function jobStatus(jobId: string): Promise<string> {
  const rows = (await harness.db.execute(sql`
    SELECT status FROM jobs WHERE id = ${jobId}
  `)) as unknown as Array<{ status: string }>;
  return rows[0]?.status ?? 'gone';
}

async function wedgesFor(jobId: string): Promise<number> {
  const rows = (await harness.db.execute(sql`
    SELECT count(*)::int AS n FROM notifications
    WHERE type = 'pipeline_wedge' AND resolution_key = ${`wedge:${jobId}`}
  `)) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

async function recordPromotion(runId: string): Promise<void> {
  const { openAttempt } = await import('../../src/release-batch/ledger.js');
  await openAttempt({ runId, stage: 'promote', idempotencyKey: 'promote-1', commit: 'abc' });
}

/** Minutes of waiting either side of the deadline, read off the constant the pass enforces. */
const deadlineMinutes = () => mods.RELEASE_UNSTARTED_DEADLINE_MS / 60_000;
const overdue = () => deadlineMinutes() + 5;
const stillWaiting = () => deadlineMinutes() - 5;

describe('a release batch whose job no box ever took', () => {
  it('cancels the job, hands the roster back and takes the run terminal', async () => {
    const a = await insertIssue();
    const b = await insertIssue();
    const { runId, jobId } = await claim([a, b]);
    expect((await stored(a)).status).toBe('releasing');
    await ageJob(jobId, overdue());

    expect(await mods.recoverUnstartedReleaseBatches(new Date())).toEqual({ recovered: 1 });

    expect(await jobStatus(jobId)).toBe('cancelled');
    for (const id of [a, b]) {
      const after = await stored(id);
      expect(after.status).toBe('awaiting_release');
      expect(after.claim).toBeNull();
      // cm:guard NOT stamped. A batch that shipped nothing must not unblock a `blocks` dependent, which a `merged_at` written here would do as surely as a real release.
      expect(after.mergedAt).toBeNull();
    }
    expect(await runStatus(runId)).toBe('cancelled');
  });

  it('says so on a surface, because the sweep writes no comment', async () => {
    const a = await insertIssue();
    const { jobId } = await claim([a]);
    await ageJob(jobId, overdue());

    await mods.recoverUnstartedReleaseBatches(new Date());

    expect(await wedgesFor(jobId)).toBe(1);
  });

  // cm:guard the boundary either side, and the pair is the test: a single overdue case passes
  // against a pass with no deadline term at all, which would cancel every batch on its first tick.
  it('leaves a batch that has not reached the deadline alone', async () => {
    const a = await insertIssue();
    const { runId, jobId } = await claim([a]);
    await ageJob(jobId, stillWaiting());

    expect(await mods.recoverUnstartedReleaseBatches(new Date())).toEqual({ recovered: 0 });

    expect(await jobStatus(jobId)).toBe('queued');
    expect((await stored(a)).status).toBe('releasing');
    expect(await runStatus(runId)).toBe('running');
  });
});

describe('what the pass must not touch', () => {
  // cm:guard a dispatched job is a RELEASE RUNNING. This is the case that makes the whole pass
  // dangerous, and the reason the fence repeats `dispatched_at IS NULL` in its own WHERE rather
  // than trusting the selection it was handed.
  it('leaves a batch whose job reached a box', async () => {
    const a = await insertIssue();
    const { runId, jobId } = await claim([a]);
    await ageJob(jobId, overdue());
    await harness.db.execute(sql`
      UPDATE jobs SET status = 'dispatched', dispatched_at = now() WHERE id = ${jobId}
    `);

    expect(await mods.recoverUnstartedReleaseBatches(new Date())).toEqual({ recovered: 0 });

    expect(await jobStatus(jobId)).toBe('dispatched');
    expect((await stored(a)).status).toBe('releasing');
    expect(await runStatus(runId)).toBe('running');
  });

  // cm:guard the requeue shape, and it is the one `status = 'queued'` alone does not catch:
  // `jobs/hold.ts:buildRequeueUpdate` writes `status` and a fresh `queued_at` and leaves
  // `dispatched_at` standing, so a release that ran, was held and was resumed looks exactly like a
  // fresh one on every column but that stamp. It has already been on a box and may have merged.
  it('leaves a batch whose job ran once and was requeued from a hold', async () => {
    const a = await insertIssue();
    const { runId, jobId } = await claim([a]);
    await harness.db.execute(sql`
      UPDATE jobs SET dispatched_at = now() - interval '2 hours' WHERE id = ${jobId}
    `);
    await ageJob(jobId, overdue());

    expect(await mods.recoverUnstartedReleaseBatches(new Date())).toEqual({ recovered: 0 });

    expect(await jobStatus(jobId)).toBe('queued');
    expect((await stored(a)).status).toBe('releasing');
    expect(await runStatus(runId)).toBe('running');
  });

  // cm:guard a HELD job is a box that prepared seconds ago and has not stamped yet — the window
  // `prepareJobForMaster` opens and `startJobForMaster` closes. Cancelling inside it would take the
  // roster out from under a release that is starting, and the three-minute master reaper already
  // clears a hold nobody follows through on.
  it('steps aside for a batch a box is in the middle of taking', async () => {
    const a = await insertIssue();
    const { runId, jobId } = await claim([a]);
    await ageJob(jobId, overdue());
    await harness.db.execute(sql`
      UPDATE jobs SET held_by = gen_random_uuid(), held_at = now() WHERE id = ${jobId}
    `);

    expect(await mods.recoverUnstartedReleaseBatches(new Date())).toEqual({ recovered: 0 });

    expect(await jobStatus(jobId)).toBe('queued');
    expect((await stored(a)).status).toBe('releasing');
    expect(await runStatus(runId)).toBe('running');
  });

  // cm:guard a run that PROMOTED has code on production, and both the status and the claim have to
  // stay: the status because no other one is true, and the claim because `release_batch_run_id` is
  // the only index onto those rows and an issue at `releasing` with no claim is reachable by
  // nothing. The query above cannot reach such a run, and this asserts the second guard that makes
  // that independent of the query staying that way.
  it('leaves a batch that recorded a promotion exactly where it stands', async () => {
    const a = await insertIssue();
    const { runId, jobId } = await claim([a]);
    await recordPromotion(runId);
    await ageJob(jobId, overdue());

    expect(await mods.recoverUnstartedReleaseBatches(new Date())).toEqual({ recovered: 0 });

    expect(await stored(a)).toMatchObject({ status: 'releasing', claim: runId });
    expect(await jobStatus(jobId)).toBe('queued');
  });
});

describe('the fence against a box that is starting the job', () => {
  // cm:guard this is the finding the plan was rewritten for. Select-then-recover could be racing
  // the box: `startJobForMaster` and the roster move would both land, and a live release would lose
  // its roster mid-flight. What makes it safe is that the fence writes `cancelled` under
  // `status = 'queued'`, which is the same predicate that start requires — so exactly one wins.
  it('makes the job unstartable, so a start arriving after it loses', async () => {
    const a = await insertIssue();
    const { jobId } = await claim([a]);
    await ageJob(jobId, overdue());

    await mods.recoverUnstartedReleaseBatches(new Date());

    const started = (await harness.db.execute(sql`
      UPDATE jobs SET status = 'dispatched', dispatched_at = now()
      WHERE id = ${jobId} AND status = 'queued'
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    expect(started).toHaveLength(0);
    expect(await jobStatus(jobId)).toBe('cancelled');
  });
});

describe('what the caller is told at the cut', () => {
  // cm:guard the deadline is REPORTED and not only enforced. Core cannot promise Rule 1's
  // synchronous "session exists or the creation refused" — `ws/rooms.ts` publishes fire-and-forget
  // with no reply, so nothing inside the request can learn whether a box took the work. What it can
  // promise is bounded, and a bound the caller cannot see is a promise only the code knows about.
  it('answers the deadline by which the batch must have an owner', async () => {
    const a = await insertIssue();
    const before = Date.now();

    const result = (await claim([a])) as unknown as { ownerDeadlineAt: string };

    const at = Date.parse(result.ownerDeadlineAt);
    expect(Number.isNaN(at)).toBe(false);
    expect(at).toBeGreaterThanOrEqual(before + mods.RELEASE_UNSTARTED_DEADLINE_MS - 5_000);
    expect(at).toBeLessThanOrEqual(Date.now() + mods.RELEASE_UNSTARTED_DEADLINE_MS + 5_000);
  });
});
