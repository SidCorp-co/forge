// ISS-1255. The steward spent a fixed 10 runner jobs and 200 gateway turns per project per UTC day,
// and ISS-1250's release judge waited about 19 hours for midnight because of it. A steward runner job
// is now a run on its project's box like any other: demand in `devices/run-slots.ts:slotsFor`, a
// release follow-through urgent, started when the project has a free slot and waiting for one, never
// for a day. The gateway-turn cap is replaced by a runaway guard: the same act on the same item,
// its standing unmoved, runs `STEWARD_ACT_REPEAT_LIMIT` times and the next is refused
// STEWARD_ACT_REPEATED, said on the item.
//
// ISS-596 c6. Which of a project's runs takes its free slot is the head of its job line, by when each
// is due its slot from its first trigger: on forge's one slot, FB-650's triage waited behind nine
// release follow-throughs, taken by whichever run's minute retry happened to be due when the slot
// freed, until a person triaged it by hand.
//
// @direct-test-of packages/core/src/steward/dispatch.ts
// @direct-test-of packages/core/src/steward/policy.ts
// @direct-test-of packages/core/src/steward/slot-demand.ts
// @direct-test-of packages/core/src/devices/run-slots-read.ts
// @direct-test-of packages/core/src/devices/ports.ts

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';

vi.mock('../../src/steward/turn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/steward/turn.js')>()),
  runGatewayAct: async () => ({ refused: [], broken: [], acts: [], error: null }),
}));

type Dispatch = typeof import('../../src/steward/dispatch.js');
let dispatch: Dispatch['dispatchStewardRuns'];
let ownerId = '';

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

/** A steward run of `act` on `subject`, as a row in `state`. */
async function stewardRun(
  projectId: string,
  subject: { kind: string; id: string; key: string },
  act: string,
  opts: { state?: string; trigger?: string; basis?: string | null; endedAgoMs?: number } = {},
): Promise<string> {
  const state = opts.state ?? 'queued';
  const ended = state === 'done' || state === 'failed';
  const [made] = await rows<{ id: string }>(sql`
    INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                              acts_to_run, state, basis, queued_at, not_before, started_at, ended_at)
    VALUES (${projectId}, ${subject.kind}, ${subject.id}, ${subject.key},
            ${opts.trigger ?? 'release.shipped'}, '[]'::jsonb, ARRAY[${act}]::text[], ${state},
            ${opts.basis ?? null}, now() - interval '3 minutes', now() - interval '1 minute',
            ${state === 'queued' ? null : sql`now() - interval '2 minutes'`},
            ${ended ? sql`now() - make_interval(secs => ${(opts.endedAgoMs ?? 60_000) / 1000})` : null})
    RETURNING id`);
  return made?.id ?? '';
}

/** Today's steward runs that each started a job and finished it: `n` runner jobs spent today. */
async function jobsRunToday(projectId: string, n: number) {
  const { db } = await import('../../src/db/client.js');
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  const { enqueueStewardJob } = await import('../../src/steward/job.js');
  const { stewardRuns } = await import('../../src/db/schema-steward-runs.js');
  const { eq } = await import('drizzle-orm');
  for (let i = 0; i < n; i += 1) {
    const key = await createTestFeedback(projectId, ownerId, 100 + i);
    const [fb] = await rows<{ id: string }>(sql`
      SELECT id FROM feedback WHERE project_id = ${projectId} AND fb_seq = ${100 + i}`);
    const id = await stewardRun(
      projectId,
      { kind: 'feedback', id: fb?.id ?? '', key },
      'triage_draft',
      {
        state: 'running',
        trigger: 'feedback.filed',
      },
    );
    const [run] = await db.select().from(stewardRuns).where(eq(stewardRuns.id, id));
    if (!run) throw new Error('the run was not written');
    const job = await enqueueStewardJob(run, ['triage_draft']);
    if (!job.ok) throw new Error(job.failure);
    await withKernelMarker(db, (tx) =>
      tx.execute(sql`UPDATE jobs SET status = 'done', finished_at = now() WHERE id = ${job.jobId}`),
    );
    await rows(sql`
      UPDATE steward_runs SET state = 'done', ended_at = now(), job_id = ${job.jobId}
       WHERE id = ${id} RETURNING id`);
  }
}

const runRow = async (id: string) =>
  (
    await rows<{
      state: string;
      skip_reason: string | null;
      failure: string | null;
      job_id: string | null;
      not_before: string;
    }>(sql`
      SELECT state, skip_reason, failure, job_id::text, not_before::text FROM steward_runs WHERE id = ${id}`)
  )[0];

describe("a shipped issue's release follow-through runs at its release, given a slot (ISS-1250)", () => {
  it('starts its job on a day the project already ran more than 10 steward jobs', async () => {
    const { db } = await import('../../src/db/client.js');
    const { foldTrigger } = await import('../../src/steward/runs-store.js');
    const { STEWARD_DEBOUNCE_MS } = await import('@forge/contracts/steward');
    const pid = (await createTestProject(ownerId)).id;
    const device = await createTestDevice(ownerId, { maxSubagents: 2 });
    await bindTestRunner(pid, device);
    await jobsRunToday(pid, 12);
    const issue = await createTestIssue(pid, ownerId, 1250, {
      status: 'closed',
      createdAt: new Date(),
      mergedAt: new Date(),
    });
    const shippedAt = new Date(Date.now() - STEWARD_DEBOUNCE_MS - 1_000);
    const shipped = await db.transaction((tx) =>
      foldTrigger(tx, {
        projectId: pid,
        subject: { kind: 'issue', id: issue.id, key: issue.key },
        trigger: 'release.shipped',
        outboxId: 'iss1250-shipped',
        at: shippedAt,
      }),
    );

    await dispatch(new Date());

    const run = await runRow(shipped.runId);
    expect(run?.skip_reason ?? null).toBeNull();
    expect(run?.state, 'the judge waited instead of starting').toBe('running');
    expect(run?.job_id, 'no job was started for the follow-through').not.toBeNull();
    const [job] = await rows<{ type: string; acts: string[] }>(sql`
      SELECT type, payload -> 'stewardActs' AS acts FROM jobs WHERE id = ${run?.job_id ?? null}`);
    expect(job).toEqual({ type: 'steward', acts: ['release_followthrough'] });
    // nothing on the issue says it waits for a day
    const said = await rows<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${issue.id}`,
    );
    expect(said.map((c) => c.body).join('\n')).not.toMatch(/next day|UTC day|budget/);
    // the job it started holds a slot of its project on the box, as any run does
    const { readBoxSlots } = await import('../../src/devices/run-slots-read.js');
    const mine = (await readBoxSlots(device)).projects.find((p) => p.projectId === pid);
    expect(mine).toMatchObject({ inUse: 1 });
  });

  it('waits for a slot, urgent, while its project holds none free, and starts once one frees', async () => {
    const { db } = await import('../../src/db/client.js');
    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    const { enqueueStewardJob } = await import('../../src/steward/job.js');
    const { stewardRuns } = await import('../../src/db/schema-steward-runs.js');
    const { readBoxSlots, subagentSlotsOf } = await import('../../src/devices/run-slots-read.js');
    const { eq } = await import('drizzle-orm');
    const pid = (await createTestProject(ownerId)).id;
    const device = await createTestDevice(ownerId, { maxSubagents: 1 });
    await bindTestRunner(pid, device);
    // another of its steward jobs is out with the box and holds its one slot
    const key = await createTestFeedback(pid, ownerId, 7);
    const [fb] = await rows<{ id: string }>(sql`
      SELECT id FROM feedback WHERE project_id = ${pid} AND fb_seq = 7`);
    const busyId = await stewardRun(
      pid,
      { kind: 'feedback', id: fb?.id ?? '', key },
      'triage_draft',
      {
        state: 'running',
        trigger: 'feedback.filed',
      },
    );
    const [busy] = await db.select().from(stewardRuns).where(eq(stewardRuns.id, busyId));
    if (!busy) throw new Error('the busy run was not written');
    const live = await enqueueStewardJob(busy, ['triage_draft']);
    if (!live.ok) throw new Error(live.failure);
    await rows(
      sql`UPDATE steward_runs SET job_id = ${live.jobId} WHERE id = ${busyId} RETURNING id`,
    );
    const issue = await createTestIssue(pid, ownerId, 1251, {
      status: 'closed',
      createdAt: new Date(),
      mergedAt: new Date(),
    });
    const judge = await stewardRun(
      pid,
      { kind: 'issue', id: issue.id, key: issue.key },
      'release_followthrough',
    );

    await dispatch(new Date());

    const waiting = await runRow(judge);
    expect(waiting).toMatchObject({ state: 'queued', skip_reason: null, job_id: null });
    // it waits for the slot, a minute, never for the next UTC day
    expect(new Date(waiting?.not_before ?? 0).getTime() - Date.now()).toBeLessThanOrEqual(61_000);
    // the slot read counts it as the project's demand, urgent, and the master's standing reads it as
    // one run waiting for a slot like any other
    const box = await readBoxSlots(device);
    const mine = box.projects.find((p) => p.projectId === pid);
    expect(mine).toMatchObject({ wants: 2, slots: 1, inUse: 1, waiting: 1, urgent: true });
    expect(subagentSlotsOf(box, pid)).toEqual({ held: 1, inUse: 1, waiting: 1, capacity: 1 });

    // the busy job ends, its run with it: the slot frees and the judge starts on the next tick
    await withKernelMarker(db, (tx) =>
      tx.execute(
        sql`UPDATE jobs SET status = 'done', finished_at = now() WHERE id = ${live.jobId}`,
      ),
    );
    await rows(
      sql`UPDATE steward_runs SET state = 'done', ended_at = now() WHERE id = ${busyId} RETURNING id`,
    );
    await dispatch(new Date(Date.now() + 61_000));

    const started = await runRow(judge);
    expect(started?.state).toBe('running');
    expect(started?.job_id).not.toBeNull();
  });
});

describe('the runaway guard: the same act on one item, its standing unmoved (ISS-1255)', () => {
  async function filedItem(pid: string, seq: number) {
    const { openStandings } = await import('../../src/steward/ports.js');
    const key = await createTestFeedback(pid, ownerId, seq);
    const [fb] = await rows<{ id: string }>(sql`
      SELECT id FROM feedback WHERE project_id = ${pid} AND fb_seq = ${seq}`);
    const standing = (await openStandings(pid)).find((r) => r.subject.key === key);
    if (!standing) throw new Error(`${key} has no open standing`);
    return { subject: { kind: 'feedback', id: fb?.id ?? '', key }, basis: standing.basis };
  }

  it('lets the act run up to its limit, then refuses it STEWARD_ACT_REPEATED and says so on the item', async () => {
    const { STEWARD_ACT_REPEAT_LIMIT } = await import('../../src/steward/policy.js');
    const { openStandings } = await import('../../src/steward/ports.js');
    const pid = (await createTestProject(ownerId)).id;
    const { subject, basis } = await filedItem(pid, 30);
    for (let n = 0; n < STEWARD_ACT_REPEAT_LIMIT - 1; n += 1) {
      await stewardRun(pid, subject, 'note', { state: 'done', trigger: 'standing.changed', basis });
    }
    // one short of the limit: the act runs (boundary)
    const last = await stewardRun(pid, subject, 'note', { trigger: 'standing.changed', basis });
    await dispatch(new Date());
    expect(await runRow(last)).toMatchObject({ state: 'done', failure: null });

    // at the limit: refused, naming the item, the act and the count
    const over = await stewardRun(pid, subject, 'note', { trigger: 'standing.changed', basis });
    await dispatch(new Date());
    const refused = await runRow(over);
    expect(refused?.state).toBe('failed');
    expect(refused?.failure).toMatch(
      new RegExp(
        `^STEWARD_ACT_REPEATED: note on ${subject.key} already ran ${STEWARD_ACT_REPEAT_LIMIT} times`,
      ),
    );
    const [kind] = await rows<{ failure_kind: string }>(sql`
      SELECT failure_kind FROM steward_runs WHERE id = ${over}`);
    expect(kind?.failure_kind).toBe('refused');
    // and the item says it, in words
    const row = (await openStandings(pid)).find((r) => r.subject.key === subject.key);
    expect(row?.note?.lines[0]).toContain(`its note here ${STEWARD_ACT_REPEAT_LIMIT} times`);
  });

  it('counts only the runs since the standing last moved (negative)', async () => {
    const { STEWARD_ACT_REPEAT_LIMIT } = await import('../../src/steward/policy.js');
    const pid = (await createTestProject(ownerId)).id;
    const { subject, basis } = await filedItem(pid, 31);
    for (let n = 0; n < STEWARD_ACT_REPEAT_LIMIT; n += 1) {
      await stewardRun(pid, subject, 'note', {
        state: 'done',
        trigger: 'standing.changed',
        basis,
        endedAgoMs: 120_000,
      });
    }
    // the standing moved since: a run on another basis ended after them
    await stewardRun(pid, subject, 'note', {
      state: 'done',
      trigger: 'standing.changed',
      basis: 'moved-since',
      endedAgoMs: 60_000,
    });
    const again = await stewardRun(pid, subject, 'note', { trigger: 'standing.changed', basis });
    await dispatch(new Date());
    expect(await runRow(again)).toMatchObject({ state: 'done', failure: null });
  });
});

describe("a filed item's triage takes the next slot that frees, ahead of a follow-through backlog (ISS-596 c6)", () => {
  /** A queued steward run owing `act`, its trigger at `eventAgoMs`, due for its retry `dueInMs` from now. */
  async function lined(
    pid: string,
    subject: { kind: string; id: string; key: string },
    act: 'triage_draft' | 'release_followthrough',
    opts: { eventAgoMs: number; dueInMs: number },
  ): Promise<string> {
    const trigger = act === 'triage_draft' ? 'feedback.filed' : 'release.shipped';
    const at = new Date(Date.now() - opts.eventAgoMs).toISOString();
    const events = JSON.stringify([{ trigger, outboxId: `iss596-${subject.key}`, at }]);
    const [made] = await rows<{ id: string }>(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                                acts_to_run, state, queued_at, not_before)
      VALUES (${pid}, ${subject.kind}, ${subject.id}, ${subject.key}, ${trigger}, ${events}::jsonb,
              ARRAY[${act}]::text[], 'queued', now() - interval '1 minute',
              now() + make_interval(secs => ${opts.dueInMs / 1000}))
      RETURNING id`);
    return made?.id ?? '';
  }

  async function shippedIssue(pid: string, seq: number) {
    const issue = await createTestIssue(pid, ownerId, seq, {
      status: 'closed',
      createdAt: new Date(),
      mergedAt: new Date(),
    });
    return { kind: 'issue', id: issue.id, key: issue.key };
  }

  async function filedItem(pid: string, seq: number) {
    const key = await createTestFeedback(pid, ownerId, seq);
    const [fb] = await rows<{ id: string }>(sql`
      SELECT id FROM feedback WHERE project_id = ${pid} AND fb_seq = ${seq}`);
    return { kind: 'feedback', id: fb?.id ?? '', key };
  }

  /** End the run's job and the run with it: its slot frees. */
  async function finish(runId: string) {
    const { db } = await import('../../src/db/client.js');
    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    const job = (await runRow(runId))?.job_id ?? null;
    if (!job) throw new Error('the run holds no job to finish');
    await withKernelMarker(db, (tx) =>
      tx.execute(sql`UPDATE jobs SET status = 'done', finished_at = now() WHERE id = ${job}`),
    );
    await rows(
      sql`UPDATE steward_runs SET state = 'done', ended_at = now() WHERE id = ${runId} RETURNING id`,
    );
  }

  const withJob = async (ids: string[]) =>
    (await Promise.all(ids.map(runRow))).filter((r) => r?.job_id != null).length;

  it('starts the triage in the slot that frees, before the backlog drains, then drains the backlog', async () => {
    const pid = (await createTestProject(ownerId)).id;
    const device = await createTestDevice(ownerId, { maxSubagents: 1 });
    await bindTestRunner(pid, device);
    // three follow-throughs of a release shipped half an hour ago, each due for its retry now
    const backlog: string[] = [];
    for (const seq of [5961, 5962, 5963]) {
      backlog.push(
        await lined(pid, await shippedIssue(pid, seq), 'release_followthrough', {
          eventAgoMs: 30 * 60_000,
          dueInMs: -60_000,
        }),
      );
    }
    // the item was filed three minutes ago; its own retry for the slot comes half a minute from now
    const triage = await lined(pid, await filedItem(pid, 596), 'triage_draft', {
      eventAgoMs: 3 * 60_000,
      dueInMs: 30_000,
    });

    // the slot is free and only the backlog is due: no follow-through takes it from the triage
    await dispatch(new Date());
    expect(await withJob(backlog), 'a follow-through took the slot the triage is owed').toBe(0);
    const called = await runRow(triage);
    expect(called?.state).toBe('queued');
    expect(
      new Date(called?.not_before ?? 0).getTime(),
      'the triage was not made due',
    ).toBeLessThanOrEqual(Date.now());

    // the next tick starts it, the backlog still waiting
    await dispatch(new Date());
    const started = await runRow(triage);
    expect(started?.state).toBe('running');
    expect(started?.job_id, 'the triage did not start in the free slot').not.toBeNull();
    expect(await withJob(backlog)).toBe(0);

    // its job ends: the backlog takes the slots that free, one at a time, never starved
    await finish(triage);
    await dispatch(new Date(Date.now() + 61_000));
    expect(await withJob(backlog)).toBe(1);
  });

  it('lets a follow-through that has waited past its hour go ahead of a fresh triage (boundary)', async () => {
    const pid = (await createTestProject(ownerId)).id;
    const device = await createTestDevice(ownerId, { maxSubagents: 1 });
    await bindTestRunner(pid, device);
    const overdue = await lined(pid, await shippedIssue(pid, 5964), 'release_followthrough', {
      eventAgoMs: 2 * 60 * 60_000,
      dueInMs: -60_000,
    });
    const fresh = await lined(pid, await filedItem(pid, 597), 'triage_draft', {
      eventAgoMs: 60_000,
      dueInMs: -60_000,
    });

    await dispatch(new Date());

    expect(
      (await runRow(overdue))?.job_id,
      'the overdue follow-through was starved',
    ).not.toBeNull();
    expect(await runRow(fresh)).toMatchObject({ state: 'queued', job_id: null });
  });
});
