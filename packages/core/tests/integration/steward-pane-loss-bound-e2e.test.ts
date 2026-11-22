// ISS-1415 c1–c3: a steward job whose box reports "the job's pane … ended without reporting an
// outcome" is not placed again at once. gwork's ISS-109 follow-through went out about 31 times in 95
// minutes on 2026-11-22: a failed steward job is never retried by the pool, the item's next run
// starts a fresh one, and a shipped issue reads no open standing, so no basis held it as a repeat.
// Each next job of the item now waits 2, 4, 8 minutes after 1, 2, 3 losses in a row; the 4th is
// placed held for a person's resume, named on a wedge; the item's standing read says the count and
// the next placement time; a person's resume and a job that succeeds each start the count again.
//
// @direct-test-of packages/core/src/steward/dispatch.ts
// @direct-test-of packages/core/src/steward/pane-loss.ts
// @direct-test-of packages/core/src/steward/job.ts
// @direct-test-of packages/core/src/steward/slot-demand.ts
// @direct-test-of packages/core/src/steward/read.ts
// @direct-test-of packages/core/src/pipeline/enqueue-helper.ts

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';

type Dispatch = typeof import('../../src/steward/dispatch.js');
let dispatch: Dispatch['dispatchStewardRuns'];
let projectId = '';
let ownerId = '';
let deviceId = '';
let issue = { id: '', key: '' };

const PANE_ENDED = (id: string) =>
  `the job's pane \`forge-job-${id}\` ended without reporting an outcome`;

/** A queued follow-through run on the shipped issue, due now. */
async function queueFollowThrough(): Promise<string> {
  const [made] = await rows<{ id: string }>(sql`
    INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                              state, queued_at, not_before)
    VALUES (${projectId}, 'issue', ${issue.id}, ${issue.key}, 'release.shipped', '[]'::jsonb,
            ARRAY['release_followthrough']::text[], 'queued', now() - interval '1 minute',
            now() - interval '1 second')
    RETURNING id`);
  return made?.id ?? '';
}

interface Placed {
  runId: string;
  jobId: string;
  status: string;
  retryAfterAt: string | null;
  failureReason: string | null;
}

/** Take the item's next run up, and read the job it placed. */
async function placeNext(): Promise<Placed> {
  const runId = await queueFollowThrough();
  await dispatch(new Date());
  const [job] = await rows<{
    job_id: string;
    status: string;
    retry_after_at: string | null;
    failure_reason: string | null;
  }>(sql`
    SELECT r.job_id::text AS job_id, j.status, j.retry_after_at::text AS retry_after_at,
           j.failure_reason
      FROM steward_runs r JOIN jobs j ON j.id = r.job_id
     WHERE r.id = ${runId}`);
  if (!job) throw new Error(`run ${runId} placed no job`);
  return {
    runId,
    jobId: job.job_id,
    status: job.status,
    retryAfterAt: job.retry_after_at,
    failureReason: job.failure_reason,
  };
}

/** A job's status written as the kernel writes it, the guard satisfied. */
async function kernel(statement: ReturnType<typeof sql>): Promise<void> {
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  const { db } = await import('../../src/db/client.js');
  await withKernelMarker(db, (tx) => tx.execute(statement));
}

/** The box ends the placed job as gone, and its run ends failed with it, a moment ago. */
async function loseItsPane(placed: Placed): Promise<void> {
  await kernel(sql`
    UPDATE jobs SET status = 'failed', error = ${PANE_ENDED(placed.jobId)},
                    failure_reason = ${PANE_ENDED(placed.jobId)}, failure_kind = 'infra',
                    finished_at = now() - interval '1 second'
     WHERE id = ${placed.jobId}`);
  await rows(sql`
    UPDATE steward_runs SET state = 'failed', failure = 'its job lost its pane', failure_kind = 'error',
                            ended_at = now() - interval '1 second'
     WHERE id = ${placed.runId} RETURNING id`);
}

/** The placed job finishes its acts. */
async function succeed(placed: Placed): Promise<void> {
  await kernel(
    sql`UPDATE jobs SET status = 'done', finished_at = now() WHERE id = ${placed.jobId}`,
  );
  await rows(sql`
    UPDATE steward_runs SET state = 'done', ended_at = now() WHERE id = ${placed.runId} RETURNING id`);
}

const waitedMs = (p: Placed) =>
  p.retryAfterAt ? new Date(p.retryAfterAt).getTime() - Date.now() : 0;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  deviceId = await createTestDevice(ownerId);
  await bindTestRunner(projectId, deviceId);
  issue = await createTestIssue(projectId, ownerId, 109, {
    status: 'closed',
    createdAt: new Date(),
    mergedAt: new Date(),
  });
  dispatch = (await import('../../src/steward/dispatch.js')).dispatchStewardRuns;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe("an item whose box keeps losing its steward job's pane is placed after a growing wait, then held (ISS-1415)", () => {
  it('waits 2, 4 and 8 minutes after 1, 2 and 3 losses, and places the 4th held, naming it', async () => {
    const { readStewardRuns } = await import('../../src/steward/read.js');
    const { stewardSlotDemand } = await import('../../src/steward/slot-demand.js');
    const { db } = await import('../../src/db/client.js');

    const first = await placeNext();
    expect(first.status).toBe('queued');
    expect(waitedMs(first), 'a first job waits for nothing').toBeLessThanOrEqual(0);
    await loseItsPane(first);

    let placed = first;
    for (const [n, minutes] of [
      [1, 2],
      [2, 4],
      [3, 8],
    ] as const) {
      placed = await placeNext();
      expect(placed.status, `after ${n} loss(es)`).toBe('queued');
      expect(waitedMs(placed), `after ${n} loss(es)`).toBeGreaterThan((minutes - 0.5) * 60_000);
      expect(waitedMs(placed), `after ${n} loss(es)`).toBeLessThanOrEqual(minutes * 60_000);
      // a job waiting out its item's lost panes holds no slot until its time
      expect((await stewardSlotDemand(db, deviceId)).get(projectId)?.live ?? 0).toBe(0);
      // the standing read names the count and the next placement time while it waits
      const read = await readStewardRuns({ projectId, userId: ownerId, subjectKey: issue.key });
      expect(read.placement).toMatchObject({ paneLosses: n, stopped: false });
      expect(read.placement.nextAt).not.toBeNull();
      await loseItsPane(placed);
    }

    const held = await placeNext();
    expect(held).toMatchObject({ status: 'held', failureReason: 'pane_lost_repeatedly' });
    expect((await stewardSlotDemand(db, deviceId)).get(projectId)?.live ?? 0).toBe(0);
    const read = await readStewardRuns({ projectId, userId: ownerId, subjectKey: issue.key });
    expect(read.placement).toMatchObject({ paneLosses: 4, stopped: true, nextAt: null });
    expect(read.placement.lastFailure).toContain('ended without reporting an outcome');
    const [wedge] = await rows<{ title: string; body: string }>(sql`
      SELECT title, body FROM notifications
       WHERE project_id = ${projectId} AND type = 'pipeline_wedge'
         AND resolution_key LIKE ${`%${held.jobId}%`}`);
    expect(wedge?.title).toContain(issue.key);
    expect(wedge?.body).toContain('4 times in a row');
    expect(wedge?.body).toContain('ended without reporting an outcome');
  });

  it("starts the count again at a person's resume, and again at a job that succeeds", async () => {
    const { resumeHeldJob } = await import('../../src/jobs/resume-job.js');
    const [live] = await rows<{ run_id: string; job_id: string }>(sql`
      SELECT r.id::text AS run_id, r.job_id::text AS job_id FROM steward_runs r
        JOIN jobs j ON j.id = r.job_id
       WHERE r.subject_id = ${issue.id} AND j.status = 'held'`);
    if (!live) throw new Error('no held job to resume');
    await resumeHeldJob(live.job_id, {
      actorUserId: ownerId,
      actor: { type: 'user', id: ownerId, agency: 'human' },
      reason: 'the box runs a runner that keeps its panes now',
      source: 'rest',
    });
    const resumed: Placed = {
      runId: live.run_id,
      jobId: live.job_id,
      status: 'queued',
      retryAfterAt: null,
      failureReason: null,
    };
    // the resumed job is lost too: one loss since the person's ask, so a 2-minute wait, not a hold
    await loseItsPane(resumed);
    const after = await placeNext();
    expect(after.status).toBe('queued');
    expect(waitedMs(after)).toBeGreaterThan(1.5 * 60_000);
    expect(waitedMs(after)).toBeLessThanOrEqual(2 * 60_000);
    // that one succeeds: the next is placed at once
    await succeed(after);
    const next = await placeNext();
    expect(next.status).toBe('queued');
    expect(waitedMs(next)).toBeLessThanOrEqual(0);
  });
});
