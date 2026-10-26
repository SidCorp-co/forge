// ISS-618 c1, judged on dev.325 (K97): FB-292 was filed with the day's 10 runner jobs spent and no
// steward job live. Its note turn fit, yet admitRun priced note and triage together, refused the
// whole run budget_spent, and runOne ended it skipped: the note never ran, and nothing raised the
// triage again before the item turned stuck. The turns that fit run now; the job waits for the next
// UTC day as a queued run, and a run nothing fits today is deferred, never ended unrun.
//
// @direct-test-of packages/core/src/steward/dispatch.ts
// @direct-test-of packages/core/src/steward/runs-store.ts

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestFeedback,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';

vi.mock('../../src/steward/turn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/steward/turn.js')>()),
  runGatewayAct: async () => ({ refused: [], broken: [], acts: [], error: null }),
}));

let dispatch: typeof import('../../src/steward/dispatch.js')['dispatchStewardRuns'];
let ownerId = '';

const BOUND_MS = 150_000;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  dispatch = (await import('../../src/steward/dispatch.js')).dispatchStewardRuns;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe("a filed item's run starts within the bound while the day's runner jobs are spent", () => {
  /** A project whose day has spent all 10 runner jobs on finished jobs: none live. */
  async function spentDay() {
    const { db } = await import('../../src/db/client.js');
    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    const { enqueueStewardJob } = await import('../../src/steward/job.js');
    const { stewardRuns } = await import('../../src/db/schema-steward-runs.js');
    const { eq } = await import('drizzle-orm');
    const pid = (await createTestProject(ownerId)).id;
    await bindTestRunner(pid, await createTestDevice(ownerId));
    for (let n = 0; n < 10; n += 1) {
      const key = await createTestFeedback(pid, ownerId, 100 + n);
      const [fb] = await rows<{ id: string }>(sql`
        SELECT id FROM feedback WHERE project_id = ${pid} AND fb_seq = ${100 + n}`);
      const [made] = await rows<{ id: string }>(sql`
        INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                                  acts_to_run, state, not_before, started_at)
        VALUES (${pid}, 'feedback', ${fb?.id}, ${key}, 'feedback.filed', '[]'::jsonb,
                ARRAY['triage_draft']::text[], 'running', now(), now())
        RETURNING id`);
      const [run] = await db
        .select()
        .from(stewardRuns)
        .where(eq(stewardRuns.id, made?.id ?? ''));
      if (!run) throw new Error('the spent run was not written');
      const job = await enqueueStewardJob(run, ['triage_draft']);
      if (!job.ok) throw new Error(job.failure);
      // a finished job: the day spent it, and none is live
      await withKernelMarker(db, (tx) =>
        tx.execute(
          sql`UPDATE jobs SET status = 'done', finished_at = now() WHERE id = ${job.jobId}`,
        ),
      );
      await rows(sql`
        UPDATE steward_runs SET state = 'done', ended_at = now(), job_id = ${job.jobId}
         WHERE id = ${run.id} RETURNING id`);
    }
    return pid;
  }

  const midnight = (now: Date) =>
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);

  it('starts with the note turn, and its triage waits as the next run for the next day', async () => {
    const { db } = await import('../../src/db/client.js');
    const { foldTrigger } = await import('../../src/steward/runs-store.js');
    const { stewardJobLive } = await import('../../src/steward/job.js');
    const { budgetDayOf } = await import('../../src/steward/policy.js');
    const { STEWARD_DEBOUNCE_MS } = await import('@forge/contracts/steward');
    const pid = await spentDay();
    const now = new Date();
    expect((await budgetDayOf(pid, now)).handoff.runnerJobs.spent).toBe(10);
    expect(await stewardJobLive(pid)).toBe(false);
    const key = await createTestFeedback(pid, ownerId, 292);
    const [fb] = await rows<{ id: string }>(sql`
      SELECT id FROM feedback WHERE project_id = ${pid} AND fb_seq = 292`);
    const subject = { kind: 'feedback' as const, id: fb?.id ?? '', key };
    const filedAt = new Date(Date.now() - STEWARD_DEBOUNCE_MS - 1_000);
    const filed = await db.transaction((tx) =>
      foldTrigger(tx, {
        projectId: pid,
        subject,
        trigger: 'feedback.filed',
        outboxId: 'fb292-filed',
        at: filedAt,
      }),
    );
    await dispatch(now);

    const [run] = await rows<{
      state: string;
      skip_reason: string | null;
      started_at: string | null;
      acts: string[];
    }>(sql`
      SELECT state, skip_reason, started_at::text, acts_to_run AS acts FROM steward_runs
       WHERE id = ${filed.runId}`);
    expect(run?.started_at, 'FB-292 was not started').not.toBeNull();
    expect(new Date(run?.started_at ?? 0).getTime() - filedAt.getTime()).toBeLessThanOrEqual(
      BOUND_MS,
    );
    expect(run).toMatchObject({ state: 'done', skip_reason: null, acts: ['note'] });
    // its triage is not dropped: the item's next run owes it, due when the next day's budget opens
    const [next] = await rows<{ acts: string[]; state: string; not_before: string }>(sql`
      SELECT acts_to_run AS acts, state, not_before::text FROM steward_runs
       WHERE subject_id = ${subject.id} AND id <> ${filed.runId}`);
    expect(next).toMatchObject({ acts: ['triage_draft'], state: 'queued' });
    expect(new Date(next?.not_before ?? 0).getTime()).toBe(midnight(now));
  });

  it('defers a run owing only a job to the next day, never ending it unrun', async () => {
    const pid = await spentDay();
    const key = await createTestFeedback(pid, ownerId, 293);
    const [fb] = await rows<{ id: string }>(sql`
      SELECT id FROM feedback WHERE project_id = ${pid} AND fb_seq = 293`);
    const [made] = await rows<{ id: string }>(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                                acts_to_run, state, queued_at, not_before)
      VALUES (${pid}, 'feedback', ${fb?.id}, ${key}, 'feedback.filed', '[]'::jsonb,
              ARRAY['triage_draft']::text[], 'queued', now() - interval '3 minutes',
              now() - interval '1 minute')
      RETURNING id`);
    const now = new Date();
    await dispatch(now);
    const [run] = await rows<{ state: string; skip_reason: string | null; not_before: string }>(sql`
      SELECT state, skip_reason, not_before::text FROM steward_runs WHERE id = ${made?.id}`);
    expect(run).toMatchObject({ state: 'queued', skip_reason: null });
    expect(new Date(run?.not_before ?? 0).getTime()).toBe(midnight(now));
  });
});
