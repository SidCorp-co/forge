/**
 * ISS-1421 r4 — anhome ISS-783 stood at Releasing from 2026-10-13 under release run d954e63d,
 * `running`, whose first job failed and whose retry sat `held` and was never sent. The releasing
 * sweep counts a running run as live, the silent recovery reads only a job a box took and the
 * unstarted one only a queued job, so nothing ever read it. The held recovery reads it: a hold that
 * does not clear by itself, or one past the deadline a release may wait for a box, is fenced and its
 * roster handed back with a comment saying why its job was held and carrying the run's page. A hold
 * on a decision a person owes is handed back too (r5): Releasing is not a state an issue waits in.
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
  how: {
    reason: string;
    autoRelease: boolean;
    minutesAgo: number;
    decision?: 'owed' | 'answered';
  },
): Promise<void> {
  const heldAt = new Date(Date.now() - how.minutesAgo * 60_000).toISOString();
  const state = JSON.stringify({ reason: how.reason, heldAt, autoRelease: how.autoRelease });
  const ref = { v: 1, questionIds: [], since: heldAt };
  const decision =
    how.decision === 'owed'
      ? sql`|| jsonb_build_object('awaitingDecision', ${JSON.stringify(ref)}::jsonb)`
      : how.decision === 'answered'
        ? sql`|| jsonb_build_object('awaitingDecision', ${JSON.stringify({ ...ref, answeredAt: heldAt })}::jsonb)`
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
        'Its release could never move: its job was held because it failed on every retry, and nothing would send it again.',
      );
      // ISS-1421 r5: the run is linked by its page, never named in words a reader cannot open.
      expect(said).toMatch(
        new RegExp(
          `The release it was in is at https?://\\S+/projects/[^/\\s]+/releases/${runId}\\.`,
        ),
      );
      expect(said).not.toMatch(/\/api\//);
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

  it('hands back one whose decision was answered and whose resumed job was then held for good', async () => {
    const a = await fx.insertIssue();
    const { jobId } = await fx.claim([a]);
    await hold(jobId, {
      reason: 'retry_rounds_exhausted',
      autoRelease: false,
      minutesAgo: 1,
      decision: 'answered',
    });

    expect(await m.recover(new Date())).toEqual({ recovered: 1 });
    expect(await fx.stored(a)).toMatchObject({ status: 'awaiting_release', claim: null });
  });

  it('finishes a hand-back a pass cut short after fencing the job', async () => {
    const a = await fx.insertIssue();
    const { runId, jobId } = await fx.claim([a]);
    await hold(jobId, { reason: 'retry_rounds_exhausted', autoRelease: false, minutesAgo: 1 });
    const { HELD_HANDBACK_REASON } = await import('../../src/release-batch/held-recovery.js');
    // The fence committed; the process stopped before the roster went back.
    await harness.db.execute(sql`
      UPDATE jobs SET status = 'cancelled', finished_at = now(), error = ${HELD_HANDBACK_REASON}
      WHERE id = ${jobId}
    `);
    expect(await fx.stored(a)).toMatchObject({ status: 'releasing', claim: runId });

    expect(await m.recover(new Date())).toEqual({ recovered: 1 });
    expect(await fx.stored(a)).toMatchObject({ status: 'awaiting_release', claim: null });
    expect(await fx.runStatus(runId)).not.toBe('running');
    expect(await m.recover(new Date())).toEqual({ recovered: 0 });
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

// ISS-1421 r5 — anhome ISS-783 stood at Releasing from 2026-10-13 because its release job was held
// on question b210f881, and the r4 pass left a decision hold alone however long it waited.
describe('a release held on a decision a person owes (criterion 67)', () => {
  it('is handed back on the first pass, however young the hold', async () => {
    const a = await fx.insertIssue();
    const b = await fx.insertIssue();
    const { runId, jobId } = await fx.claim([a, b]);
    await hold(jobId, {
      reason: 'awaiting_decision',
      autoRelease: false,
      minutesAgo: 1,
      decision: 'owed',
    });

    expect(await m.recover(new Date())).toEqual({ recovered: 1 });

    const { DECISION_HANDBACK_REASON } = await import('../../src/release-batch/decision-state.js');
    expect(await job(jobId)).toEqual({ status: 'cancelled', error: DECISION_HANDBACK_REASON });
    for (const id of [a, b]) {
      expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
      const said = (await bodies(id)).join('\n');
      expect(said).toContain(
        'This release waited on a decision a person owes, so it was handed back',
      );
      expect(said).toContain(`/releases/${runId}.`);
    }
    expect(await fx.runStatus(runId)).not.toBe('running');
    expect(await m.recover(new Date())).toEqual({ recovered: 0 });
  });

  it('finishes a decision hand-back a pass cut short after fencing the job, and says the same', async () => {
    const a = await fx.insertIssue();
    const { runId, jobId } = await fx.claim([a]);
    await hold(jobId, {
      reason: 'awaiting_decision',
      autoRelease: false,
      minutesAgo: 1,
      decision: 'owed',
    });
    const { DECISION_HANDBACK_REASON } = await import('../../src/release-batch/decision-state.js');
    await harness.db.execute(sql`
      UPDATE jobs SET status = 'cancelled', finished_at = now(), error = ${DECISION_HANDBACK_REASON}
      WHERE id = ${jobId}
    `);

    expect(await m.recover(new Date())).toEqual({ recovered: 1 });
    expect(await fx.stored(a)).toMatchObject({ status: 'awaiting_release', claim: null });
    expect((await bodies(a)).join('\n')).toContain('waited on a decision a person owes');
    expect(await fx.runStatus(runId)).not.toBe('running');
  });
});

// ISS-1421 r6 — judge-37 read anhome ISS-783's comment say both "released again once it is answered"
// and "a person decides whether it goes back to work or into another batch". One comment, one next
// step, read off how the project releases (criterion 67).
describe("a decision hand-back's comment ends on one next step (criterion 67)", () => {
  async function handBack(): Promise<string> {
    const a = await fx.insertIssue();
    const { jobId } = await fx.claim([a]);
    await hold(jobId, { reason: 'awaiting_decision', autoRelease: false, minutesAgo: 1, decision: 'owed' });
    expect(await m.recover(new Date())).toEqual({ recovered: 1 });
    return (await bodies(a)).join('\n');
  }

  it('says to answer, then start the next release, where a person releases', async () => {
    const said = await handBack();
    expect(said).toContain('Answer the question, then start the next release from Awaiting release.');
    expect(said).not.toContain('released again once it is answered');
    expect(said).not.toMatch(/a person decides/i);
    expect(said).not.toContain('answering the question is enough');
  });

  it('says answering is enough where the project releases automatically', async () => {
    await harness.db.execute(sql`
      UPDATE projects SET agent_config = jsonb_set(
        COALESCE(agent_config, '{}'::jsonb), '{pipelineConfig}',
        COALESCE(agent_config -> 'pipelineConfig', '{}'::jsonb) || '{"autoProdDeploy": true}'::jsonb)
      WHERE id = ${projectId}
    `);
    const said = await handBack();
    expect(said).toContain('answering the question is enough');
    expect(said).not.toContain('start the next release');
    expect(said).not.toContain('released again once it is answered');
    expect(said).not.toMatch(/a person decides/i);
  });
});

// Review of r5: a release that already promoted keeps its roster for the releasing sweep, so the
// owner's notice may not say its issues were put back at the gate.
describe('a decision-held release that had already promoted', () => {
  it('leaves its roster to the releasing sweep, and its notice says so', async () => {
    const a = await fx.insertIssue();
    const { runId, jobId } = await fx.claim([a]);
    await hold(jobId, {
      reason: 'awaiting_decision',
      autoRelease: false,
      minutesAgo: 1,
      decision: 'owed',
    });
    await harness.db.execute(sql`
      INSERT INTO release_attempts (run_id, stage, idempotency_key, commit)
      VALUES (${runId}, 'promote', 'promote-1', 'abc')
    `);

    expect(await m.recover(new Date())).toEqual({ recovered: 1 });

    const [notice] = (await harness.db.execute(sql`
      SELECT body FROM notifications
      WHERE type = 'pipeline_wedge' AND resolution_key = ${`wedge:${jobId}`}
    `)) as unknown as Array<{ body: string | null }>;
    expect(notice?.body ?? '').toContain('the releasing sweep settles its issues');
    expect(notice?.body ?? '').not.toContain('put back at the release gate');
    expect(notice?.body ?? '').not.toMatch(/start the release again/);
    expect(notice?.body ?? '').toContain('no new release is needed');
  });
});

describe('a held release the recovery leaves as it found it (criterion 59)', () => {
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
