// REQ-48 BC-1, the judges' verdict on dev.270 (FB-176 waited 41 minutes): the steward starts within
// 2 minutes 30 seconds of a handoff event however long the standing's backlog. A handoff event's run
// is claimed ahead of the sweep's standing.stuck runs; runs are taken up several at once, up to the
// core's own bound; `started_at` is stamped when a run is taken up, never at claim; the pool does not
// retry a steward job, and a job whose run has ended holds no slot (ISS-1255).
//
// @direct-test-of packages/core/src/steward/dispatch.ts
// @direct-test-of packages/core/src/steward/runs-store.ts
// @direct-test-of packages/core/src/steward/slot-demand.ts
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
let deviceId = '';

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
  deviceId = await createTestDevice(ownerId);
  await bindTestRunner(projectId, deviceId);
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
    // several at once, and never more than the core takes up at once
    expect(probe.max).toBeGreaterThan(1);
    expect(probe.max).toBeLessThanOrEqual(16);
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

describe('a steward job is not retried by the pool, nor holds a slot once its run ended', () => {
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

  it('counts no slot for a steward job still live whose run ended, and claims the next runner act', async () => {
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
    const { stewardSlotDemand } = await import('../../src/steward/slot-demand.js');
    const demand = await stewardSlotDemand(db, deviceId);
    expect(demand.get(projectId)).toMatchObject({ live: 0, waiting: 1 });
    const claimed = await claimDueRuns(new Date(), 5);
    expect(claimed.map((r) => r.id)).toContain(filed);
    await drain();
  });
});

// ISS-618 c1, judged on dev.276: FB-211 stayed queued past 5 minutes behind 16 filed items' triage
// jobs, its run owing nothing but a job. Now its project's one slot on the box is taken (ISS-1255)
describe("a filed item's run starts within the bound while its project's slots are taken", () => {
  it('starts with the note turn, and its triage waits as the next run for a slot', async () => {
    const { db } = await import('../../src/db/client.js');
    const { foldTrigger } = await import('../../src/steward/runs-store.js');
    const { enqueueStewardJob } = await import('../../src/steward/job.js');
    const { stewardSlotDemand } = await import('../../src/steward/slot-demand.js');
    const { stewardRuns } = await import('../../src/db/schema-steward-runs.js');
    const { eq } = await import('drizzle-orm');
    const { STEWARD_DEBOUNCE_MS } = await import('@forge/contracts/steward');
    const lane = (await createTestProject(ownerId)).id;
    const box = await createTestDevice(ownerId, { maxSubagents: 1 });
    await bindTestRunner(lane, box);
    const item = async (seq: number) => {
      const key = await createTestFeedback(lane, ownerId, seq);
      const [row] = await rows<{ id: string }>(sql`
        SELECT id FROM feedback WHERE project_id = ${lane} AND fb_seq = ${seq}`);
      return { kind: 'feedback' as const, id: row?.id ?? '', key };
    };
    // the item whose triage job is live now, and 16 filed before FB-211 still waiting on theirs
    const busy = await item(180);
    const [running] = await rows<{ id: string }>(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                                state, not_before, started_at)
      VALUES (${lane}, 'feedback', ${busy.id}, ${busy.key}, 'feedback.filed', '[]'::jsonb,
              ARRAY['triage_draft']::text[], 'running', now(), now())
      RETURNING id`);
    const [runRow] = await db
      .select()
      .from(stewardRuns)
      .where(eq(stewardRuns.id, running?.id ?? ''));
    if (!runRow) throw new Error('the running run was not written');
    const job = await enqueueStewardJob(runRow, ['triage_draft']);
    if (!job.ok) throw new Error(job.failure);
    await rows(
      sql`UPDATE steward_runs SET job_id = ${job.jobId} WHERE id = ${runRow.id} RETURNING id`,
    );
    expect((await stewardSlotDemand(db, box)).get(lane)?.live).toBe(1);
    for (let n = 0; n < 16; n += 1) {
      const waiting = await item(184 + n);
      await rows(sql`
        INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                                  state, queued_at, not_before)
        VALUES (${lane}, 'feedback', ${waiting.id}, ${waiting.key}, 'feedback.filed', '[]'::jsonb,
                ARRAY['triage_draft']::text[], 'queued', now() - interval '9 hours',
                now() - interval '9 hours')
        RETURNING id`);
    }
    const filedAt = new Date(Date.now() - STEWARD_DEBOUNCE_MS - 1_000);
    const subject = await item(211);
    const filed = await db.transaction((tx) =>
      foldTrigger(tx, {
        projectId: lane,
        subject,
        trigger: 'feedback.filed',
        outboxId: 'fb211-filed',
        at: filedAt,
      }),
    );
    await dispatch(new Date());

    const [run] = await rows<{ state: string; started_at: string | null; acts: string[] }>(sql`
      SELECT state, started_at::text, acts_to_run AS acts FROM steward_runs WHERE id = ${filed.runId}`);
    expect(run?.started_at, 'FB-211 was not started').not.toBeNull();
    expect(new Date(run?.started_at ?? 0).getTime() - filedAt.getTime()).toBeLessThanOrEqual(
      BOUND_MS,
    );
    expect(run).toMatchObject({ state: 'done', acts: ['note'] });
    // its triage is not dropped: the item's next run owes it, queued for a slot a minute on
    const [next] = await rows<{ trigger: string; acts: string[]; state: string; due: string }>(sql`
      SELECT trigger, acts_to_run AS acts, state, not_before::text AS due FROM steward_runs
       WHERE subject_id = ${subject.id} AND id <> ${filed.runId}`);
    expect(next).toMatchObject({
      trigger: 'feedback.filed',
      acts: ['triage_draft'],
      state: 'queued',
    });
    expect(new Date(next?.due ?? 0).getTime() - Date.now()).toBeLessThanOrEqual(61_000);
    // and no job beside the live one was started past the project's slot
    const started = await rows(
      sql`SELECT id FROM jobs WHERE project_id = ${lane} AND type = 'steward'`,
    );
    expect(started).toHaveLength(1);
  });
});
