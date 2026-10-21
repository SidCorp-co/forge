// REQ-48 BC-1, the judges' verdict on dev.270 (FB-176 waited 41 minutes): the steward starts within
// 2 minutes 30 seconds of a handoff event however long the standing's backlog. A handoff event's run
// is claimed ahead of the sweep's standing.stuck runs; runs are taken up several at once, as many as
// the project's budget sizes; `started_at` is stamped when a run is taken up, never at claim; the
// pool does not retry a steward job, and a runner act is not held behind a job whose run has ended.
//
// @direct-test-of packages/core/src/steward/dispatch.ts
// @direct-test-of packages/core/src/steward/runs-store.ts
// @direct-test-of packages/core/src/steward/policy.ts
// @direct-test-of packages/core/src/jobs/retry.ts

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestRequirement,
  createTestUser,
  rows,
} from '../helpers/factories.js';

/** What the turns overlapping each other read: how many are live now, and the most at once. */
const probe = vi.hoisted(() => ({ live: 0, max: 0, turns: 0 }));

vi.mock('../../src/steward/turn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/steward/turn.js')>()),
  runGatewayAct: async () => {
    probe.live += 1;
    probe.turns += 1;
    probe.max = Math.max(probe.max, probe.live);
    await new Promise((resolve) => setTimeout(resolve, 150));
    probe.live -= 1;
    return { refused: [], broken: [], acts: [], error: null };
  },
}));

type Dispatch = typeof import('../../src/steward/dispatch.js');
let dispatch: Dispatch['dispatchStewardRuns'];
let projectId = '';
let ownerId = '';

const BOUND_MS = 150_000;

const runOf = async (id: string) =>
  (
    await rows<{ state: string; started_at: string | null; queued_at: string }>(sql`
      SELECT state, started_at::text, queued_at::text FROM steward_runs WHERE id = ${id}`)
  )[0];

/** A queued run on `subject`, due `dueAgoMs` ago and queued `queuedAgoMs` ago. */
async function queued(
  subject: { kind: string; id: string; key: string },
  trigger: string,
  act: string,
  dueAgoMs: number,
  queuedAgoMs = dueAgoMs + 120_000,
) {
  const [made] = await rows<{ id: string }>(sql`
    INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                              state, queued_at, not_before)
    VALUES (${projectId}, ${subject.kind}, ${subject.id}, ${subject.key}, ${trigger}, '[]'::jsonb,
            ARRAY[${act}]::text[], 'queued', now() - make_interval(secs => ${queuedAgoMs / 1000}),
            now() - make_interval(secs => ${dueAgoMs / 1000}))
    RETURNING id`);
  return made?.id ?? '';
}

/** End every live run of the project, so the next test starts from an empty queue. */
const drain = () =>
  rows(sql`
    UPDATE steward_runs SET state = 'skipped', skip_reason = 'subject_ended', ended_at = now()
     WHERE project_id = ${projectId} AND state IN ('queued', 'running') RETURNING id`);

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await bindTestRunner(projectId, await createTestDevice(ownerId));
  dispatch = (await import('../../src/steward/dispatch.js')).dispatchStewardRuns;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('the steward starts a handoff within 2 minutes 30 seconds under any backlog (REQ-48 BC-1)', () => {
  it("takes a handoff event's run up ahead of a 100-run standing.stuck backlog, several at once", async () => {
    for (let n = 0; n < 100; n += 1) {
      const issue = await createTestIssue(projectId, ownerId, 1000 + n, {
        status: 'open',
        createdAt: new Date(),
      });
      // the sweep's backlog: due for half an hour, older than the handoff by far
      await queued({ kind: 'issue', ...issue }, 'standing.stuck', 'stuck_diagnosis', 30 * 60_000);
    }
    const req = await createTestRequirement(projectId, 700, 'agreed just now');
    const handoff = await queued(
      { kind: 'requirement', id: req.id, key: req.key },
      'requirement.agreed',
      'intake_check',
      1_000,
      121_000,
    );
    probe.max = 0;
    await dispatch(new Date());
    const run = await runOf(handoff);
    expect(run?.started_at, 'the handoff run was not taken up on the first tick').not.toBeNull();
    const waited =
      new Date(run?.started_at ?? 0).getTime() - new Date(run?.queued_at ?? 0).getTime();
    expect(waited).toBeLessThanOrEqual(BOUND_MS);
    // several at once, as many as the default budget sizes, and never more
    expect(probe.max).toBeGreaterThan(1);
    expect(probe.max).toBeLessThanOrEqual(8);
    await drain();
  });

  it('stamps started_at when a run is taken up, never at claim', async () => {
    const { claimDueRuns } = await import('../../src/steward/runs-store.js');
    const issue = await createTestIssue(projectId, ownerId, 1200, {
      status: 'open',
      createdAt: new Date(),
    });
    const id = await queued(
      { kind: 'issue', ...issue },
      'standing.stuck',
      'stuck_diagnosis',
      1_000,
    );
    const other = await createTestIssue(projectId, ownerId, 1201, {
      status: 'open',
      createdAt: new Date(),
    });
    await queued({ kind: 'issue', ...other }, 'standing.stuck', 'stuck_diagnosis', 500);
    // a claim takes its limit and no more, however many are due
    const claimed = await claimDueRuns(new Date(), 1);
    expect(claimed.map((r) => r.id)).toEqual([id]);
    expect(await runOf(id)).toMatchObject({ state: 'running', started_at: null });
    await drain();
  });
});

describe('runs taken up at once never spend past the budget between them (REQ-48 cost guard)', () => {
  it("counts what each other run already taken up still owes, and never the run's own", async () => {
    const { spentSince } = await import('../../src/steward/runs-store.js');
    const { utcDayStart } = await import('../../src/steward/policy.js');
    const day = utcDayStart(new Date());
    const before = await spentSince(projectId, day);
    const issue = await createTestIssue(projectId, ownerId, 1250, {
      status: 'open',
      createdAt: new Date(),
    });
    const taken = await queued(
      { kind: 'issue', ...issue },
      'standing.stuck',
      'stuck_diagnosis',
      1_000,
    );
    await rows(sql`
      UPDATE steward_runs SET state = 'running', started_at = now() WHERE id = ${taken} RETURNING id`);
    // another run taken up beside it reads its one turn owed; the run itself does not
    expect((await spentSince(projectId, day)).gatewayTurns).toBe(before.gatewayTurns + 1);
    expect((await spentSince(projectId, day, { exceptRunId: taken })).gatewayTurns).toBe(
      before.gatewayTurns,
    );
    await rows(sql`UPDATE steward_runs SET turns = 1 WHERE id = ${taken} RETURNING id`);
    expect((await spentSince(projectId, day)).gatewayTurns).toBe(before.gatewayTurns + 1);
    await drain();
  });
});

describe('a steward job is not retried by the pool, nor held behind once its run ended', () => {
  it('does not schedule a pool retry for a failed steward job', async () => {
    const { scheduleAutoRetryWithVerify } = await import('../../src/jobs/retry.js');
    const { enqueueStewardJob } = await import('../../src/steward/job.js');
    const { db } = await import('../../src/db/client.js');
    const { stewardRuns } = await import('../../src/db/schema-steward-runs.js');
    const { jobs } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const issue = await createTestIssue(projectId, ownerId, 1300, {
      status: 'closed',
      createdAt: new Date(),
      mergedAt: new Date(),
    });
    const runId = await queued(
      { kind: 'issue', ...issue },
      'release.shipped',
      'release_followthrough',
      0,
    );
    const [run] = await db.select().from(stewardRuns).where(eq(stewardRuns.id, runId));
    if (!run) throw new Error('the run row was not written');
    const started = await enqueueStewardJob(run, ['release_followthrough']);
    if (!started.ok) throw new Error(started.failure);
    const [job] = await db.select().from(jobs).where(eq(jobs.id, started.jobId));
    if (!job) throw new Error('the job row was not written');
    const outcome = await scheduleAutoRetryWithVerify(
      { ...job, status: 'failed', failureAction: 'retry' },
      'the box lost the pane',
    );
    expect(outcome).toEqual({ scheduled: false, reason: 'owner_retries' });
    const retries = await rows(sql`
      SELECT id FROM jobs WHERE type = 'steward' AND payload ->> 'stewardRunId' = ${runId}`);
    expect(retries).toHaveLength(1);
    await drain();
  });

  it('claims a runner act although a steward job is live, where that job is for a run that ended', async () => {
    const { enqueueStewardJob } = await import('../../src/steward/job.js');
    const { claimDueRuns } = await import('../../src/steward/runs-store.js');
    const { db } = await import('../../src/db/client.js');
    const { stewardRuns } = await import('../../src/db/schema-steward-runs.js');
    const { eq } = await import('drizzle-orm');
    const shipped = await createTestIssue(projectId, ownerId, 1301, {
      status: 'closed',
      createdAt: new Date(),
      mergedAt: new Date(),
    });
    const endedRunId = await queued(
      { kind: 'issue', ...shipped },
      'release.shipped',
      'release_followthrough',
      0,
    );
    const [endedRun] = await db.select().from(stewardRuns).where(eq(stewardRuns.id, endedRunId));
    if (!endedRun) throw new Error('the run row was not written');
    const left = await enqueueStewardJob(endedRun, ['release_followthrough']);
    if (!left.ok) throw new Error(left.failure);
    await rows(sql`
      UPDATE steward_runs SET state = 'failed', failure = 'its job failed', failure_kind = 'error',
                              ended_at = now()
       WHERE id = ${endedRunId} RETURNING id`);
    const fb = await createTestFeedback(projectId, ownerId, 900);
    const [item] = await rows<{ id: string }>(sql`
      SELECT id FROM feedback WHERE project_id = ${projectId} AND fb_seq = 900`);
    const filed = await queued(
      { kind: 'feedback', id: item?.id ?? '', key: fb },
      'feedback.filed',
      'triage_draft',
      1_000,
    );
    const claimed = await claimDueRuns(new Date(), 5);
    expect(claimed.map((r) => r.id)).toContain(filed);
    const { stewardJobLive } = await import('../../src/steward/job.js');
    expect(await stewardJobLive(projectId)).toBe(false);
    await drain();
  });
});
