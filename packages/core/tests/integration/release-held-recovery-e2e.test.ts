/**
 * ISS-1421 r4 — anhome ISS-783 stood at Releasing from 2026-10-13 under release run d954e63d,
 * `running`, whose first job failed and whose retry sat `held` and was never sent. The releasing
 * sweep counts a running run as live, the silent recovery reads only a job a box took and the
 * unstarted one only a queued job, so nothing ever read it. The held recovery reads it: a hold that
 * does not clear by itself, or one past the deadline a release may wait for a box, is fenced and its
 * roster handed back with a comment naming the run in words and why its job was held. A hold on a
 * decision is a question a person owes, and waits for the answer however long it takes.
 *
 * Integration because the subject is which rows each pass's SQL reads, and only Postgres answers it.
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
let m: {
  recover: typeof import('../../src/release-batch/held-recovery.js').recoverHeldReleaseBatches;
  settle: typeof import('../../src/release-batch/releasing-settle.js').settleStrandedReleasing;
  silent: typeof import('../../src/release-batch/silent-recovery.js').recoverSilentReleaseBatches;
  unstarted: typeof import('../../src/release-batch/unstarted-recovery.js').recoverUnstartedReleaseBatches;
  deadlineMs: number;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  await registerIntegrationsForTest();
  const held = await import('../../src/release-batch/held-recovery.js');
  const settle = await import('../../src/release-batch/releasing-settle.js');
  const silent = await import('../../src/release-batch/silent-recovery.js');
  const unstarted = await import('../../src/release-batch/unstarted-recovery.js');
  const start = await import('../../src/release-batch/job-start.js');
  m = {
    recover: held.recoverHeldReleaseBatches,
    settle: settle.settleStrandedReleasing,
    silent: silent.recoverSilentReleaseBatches,
    unstarted: unstarted.recoverUnstartedReleaseBatches,
    deadlineMs: start.RELEASE_UNSTARTED_DEADLINE_MS,
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

beforeEach(async () => {
  await fx.declareProduction();
  await fx.seedReleaseRunner();
});

/** The release job, held the way `holdJobForReason` or the decision hold leaves it. */
async function hold(
  jobId: string,
  how: { reason: string; autoRelease: boolean; minutesAgo: number; decision?: boolean },
): Promise<void> {
  const heldAt = new Date(Date.now() - how.minutesAgo * 60_000).toISOString();
  const state = JSON.stringify({ reason: how.reason, heldAt, autoRelease: how.autoRelease });
  const decision = how.decision
    ? sql`|| jsonb_build_object('awaitingDecision', '{}'::jsonb)`
    : sql``;
  await harness.db.execute(sql`
    UPDATE jobs SET status = 'held', failure_reason = ${how.reason},
      queued_at = ${heldAt}::timestamptz,
      payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('__hold', ${state}::jsonb) ${decision}
    WHERE id = ${jobId}
  `);
}

async function job(jobId: string): Promise<{ status: string; error: string | null }> {
  const [row] = (await harness.db.execute(sql`
    SELECT status, error FROM jobs WHERE id = ${jobId}
  `)) as unknown as Array<{ status: string; error: string | null }>;
  return row ?? { status: 'gone', error: null };
}

async function bodies(issueId: string): Promise<string[]> {
  const rows = (await harness.db.execute(sql`
    SELECT body FROM comments WHERE issue_id = ${issueId} ORDER BY created_at
  `)) as unknown as Array<{ body: string }>;
  return rows.map((r) => r.body);
}

const deadlineMinutes = () => m.deadlineMs / 60_000;

describe('a release batch whose job is held with nothing to send it (criterion 57, 58)', () => {
  it('is counted live by every other pass, which is the silence this recovery ends', async () => {
    const a = await fx.insertIssue();
    const { runId, jobId } = await fx.claim([a]);
    await hold(jobId, { reason: 'retry_rounds_exhausted', autoRelease: false, minutesAgo: 1 });

    expect(await m.settle()).toMatchObject({ settled: 0 });
    expect(await m.silent(new Date())).toMatchObject({ recovered: 0 });
    expect(await m.unstarted(new Date(Date.now() + 10 * m.deadlineMs))).toEqual({ recovered: 0 });
    expect(await fx.stored(a)).toMatchObject({ status: 'releasing', claim: runId });
  });

  it('hands back a roster whose job is held for a reason that does not clear by itself', async () => {
    const a = await fx.insertIssue();
    const b = await fx.insertIssue();
    const { runId, jobId } = await fx.claim([a, b]);
    await hold(jobId, { reason: 'retry_rounds_exhausted', autoRelease: false, minutesAgo: 1 });

    expect(await m.recover(new Date())).toEqual({ recovered: 1 });

    expect(await job(jobId)).toMatchObject({ status: 'cancelled' });
    for (const id of [a, b]) {
      expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
      const said = (await bodies(id)).join('\n');
      expect(said).toContain(
        'The release run carrying this issue could never move: its job was held because it failed on every retry, and nothing would send it again.',
      );
      expect(said).not.toContain(runId);
      expect(said).not.toMatch(/retry_rounds_exhausted|failure_reason/);
    }
    expect(await fx.runStatus(runId)).not.toBe('running');
  });

  it('hands back one whose self-clearing hold has outlived the deadline', async () => {
    const a = await fx.insertIssue();
    const { jobId } = await fx.claim([a]);
    await hold(jobId, {
      reason: 'all_devices_exhausted',
      autoRelease: true,
      minutesAgo: deadlineMinutes() + 5,
    });

    expect(await m.recover(new Date())).toEqual({ recovered: 1 });
    expect(await fx.stored(a)).toMatchObject({ status: 'awaiting_release', claim: null });
    expect((await bodies(a)).join('\n')).toContain('every box that could run it was rate-limited');
  });

  it('is settled by nothing else afterwards: one pass, one comment', async () => {
    const a = await fx.insertIssue();
    const { jobId } = await fx.claim([a]);
    await hold(jobId, { reason: 'non_retryable_terminal', autoRelease: false, minutesAgo: 1 });

    await m.recover(new Date());
    expect(await m.recover(new Date())).toEqual({ recovered: 0 });
    expect(await m.settle()).toMatchObject({ settled: 0 });
    expect(await bodies(a)).toHaveLength(1);
  });
});

describe('a held release the recovery leaves as it found it (criterion 59)', () => {
  it('leaves a release held on a decision a person owes, however long it has waited', async () => {
    const a = await fx.insertIssue();
    const { runId, jobId } = await fx.claim([a]);
    await hold(jobId, {
      reason: 'awaiting_decision',
      autoRelease: false,
      minutesAgo: 10 * deadlineMinutes(),
      decision: true,
    });

    expect(await m.recover(new Date())).toEqual({ recovered: 0 });
    expect(await job(jobId)).toMatchObject({ status: 'held' });
    expect(await fx.stored(a)).toMatchObject({ status: 'releasing', claim: runId });
    expect(await bodies(a)).toEqual([]);
  });

  it('leaves a self-clearing hold younger than the deadline', async () => {
    const a = await fx.insertIssue();
    const { runId, jobId } = await fx.claim([a]);
    await hold(jobId, {
      reason: 'verify_unavailable',
      autoRelease: true,
      minutesAgo: Math.max(1, deadlineMinutes() - 5),
    });

    expect(await m.recover(new Date())).toEqual({ recovered: 0 });
    expect(await job(jobId)).toMatchObject({ status: 'held' });
    expect(await fx.stored(a)).toMatchObject({ status: 'releasing', claim: runId });
    expect(await bodies(a)).toEqual([]);
  });
});
