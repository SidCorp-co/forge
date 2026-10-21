// REQ-48 BC-1, the steward's first live run on dev.268: a runner job ends by its run's done door,
// which ends the run done, or failed naming each refusal the job reports, and settles the job. It is
// the brief's last act, so the box never reads the job's quiet pane as an infra failure after its
// acts were done. Only the project's steward calls it, once, on a job run.
//
// @direct-test-of packages/core/src/steward/job.ts
// @direct-test-of packages/core/src/steward/routes.ts

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Reply,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';

let say: (who: 'owner' | 'steward', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
const at = (path: string) => `/api/projects/${projectId}${path}`;
const as = (method: string, path: string, body?: unknown) => say('owner', method, at(path), body);

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await bindTestRunner(projectId, await createTestDevice(ownerId));
  const { stewardAccountOf } = await import('../../src/steward/account.js');
  const { mintStewardCredential } = await import('../../src/steward/credential.js');
  const stewardToken = (
    await mintStewardCredential({
      projectId,
      stewardId: await stewardAccountOf(projectId),
      acts: ['release_followthrough'],
      ttlMs: 30 * 60_000,
    })
  ).token;
  say = requester(app, { owner: await signUserToken(ownerId), steward: stewardToken });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe("a steward job ends by its run's done door (REQ-48 BC-1)", () => {
  /** A running release follow-through run whose job a box has claimed. */
  async function claimedJob(seq: number) {
    const issue = await createTestIssue(projectId, ownerId, seq, {
      status: 'closed',
      createdAt: new Date(),
      mergedAt: new Date(),
    });
    const [made] = await rows<{ id: string }>(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                                state, not_before, started_at)
      VALUES (${projectId}, 'issue', ${issue.id}, ${issue.key}, 'release.shipped', '[]'::jsonb,
              ARRAY['release_followthrough']::text[], 'running', now(), now())
      RETURNING id`);
    const runId = made?.id ?? '';
    const run = (
      await rows<Record<string, unknown>>(sql`SELECT * FROM steward_runs WHERE id = ${runId}`)
    )[0];
    const { enqueueStewardJob } = await import('../../src/steward/job.js');
    const { db } = await import('../../src/db/client.js');
    const { stewardRuns } = await import('../../src/db/schema-steward-runs.js');
    const { eq } = await import('drizzle-orm');
    const [row] = await db.select().from(stewardRuns).where(eq(stewardRuns.id, runId));
    if (!row || !run) throw new Error('the run row was not written');
    const started = await enqueueStewardJob(row, ['release_followthrough']);
    if (!started.ok) throw new Error(started.failure);
    await rows(sql`UPDATE steward_runs SET job_id = ${started.jobId} WHERE id = ${runId}`);
    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    await withKernelMarker(db, (tx) =>
      tx.execute(
        sql`UPDATE jobs SET status = 'dispatched', dispatched_at = now() WHERE id = ${started.jobId}`,
      ),
    );
    return { runId, jobId: started.jobId };
  }

  const ended = async (runId: string, jobId: string) => ({
    run: (
      await rows<{ state: string; failure: string | null; failure_kind: string | null }>(sql`
        SELECT state, failure, failure_kind FROM steward_runs WHERE id = ${runId}`)
    )[0],
    job: (
      await rows<{ status: string; payload: { promptString: string } }>(sql`
        SELECT status, payload FROM jobs WHERE id = ${jobId}`)
    )[0],
  });

  it('is briefed with the done door as its last act, which ends the run done and the job done', async () => {
    const { runId, jobId } = await claimedJob(43);
    const before = await ended(runId, jobId);
    expect(before.job?.payload.promptString).toContain(
      `POST /api/projects/${projectId}/steward-runs/${runId}/done`,
    );
    const done = await say('steward', 'POST', at(`/steward-runs/${runId}/done`), { refused: [] });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json).toEqual({ state: 'done' });
    expect(await ended(runId, jobId)).toMatchObject({
      run: { state: 'done', failure: null, failure_kind: null },
      job: { status: 'done' },
    });
    const again = await say('steward', 'POST', at(`/steward-runs/${runId}/done`), { refused: [] });
    expect([again.status, again.json.code]).toEqual([409, 'STEWARD_RUN_NOT_JOB']);
  });

  it('ends the run failed naming each refusal it reports, so it waits for the standing', async () => {
    const { runId, jobId } = await claimedJob(44);
    const refusal = 'POST /api/issues/x/verdicts: CRITERION_UNKNOWN BC-9 names no criterion';
    const done = await say('steward', 'POST', at(`/steward-runs/${runId}/done`), {
      refused: [refusal],
    });
    expect(done.json).toEqual({ state: 'failed' });
    const after = await ended(runId, jobId);
    expect(after).toMatchObject({
      run: { state: 'failed', failure_kind: 'refused' },
      job: { status: 'done' },
    });
    expect(after.run?.failure).toBe(`release_followthrough: the door refused ${refusal}`);
  });

  it('ends the run failed as broken where a door could not answer, so the hour tries it again', async () => {
    const { runId, jobId } = await claimedJob(46);
    const broke = 'POST /api/issues/x/verdicts: 503 upstream down';
    const done = await say('steward', 'POST', at(`/steward-runs/${runId}/done`), {
      refused: [],
      broken: [broke],
    });
    expect(done.json).toEqual({ state: 'failed' });
    const after = await ended(runId, jobId);
    expect(after).toMatchObject({
      run: { state: 'failed', failure_kind: 'error' },
      job: { status: 'done' },
    });
    expect(after.run?.failure).toBe(`release_followthrough: the door broke ${broke}`);
  });

  it('settles a job its run already ended, so a settlement cut short is finished by the retry', async () => {
    const { runId, jobId } = await claimedJob(47);
    const { endRun } = await import('../../src/steward/runs-store.js');
    // the run ended, and the job's settlement did not land
    await endRun(runId, { state: 'done' });
    const done = await say('steward', 'POST', at(`/steward-runs/${runId}/done`), { refused: [] });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json).toEqual({ state: 'done' });
    expect(await ended(runId, jobId)).toMatchObject({
      run: { state: 'done' },
      job: { status: 'done' },
    });
  });

  it("revokes the job's token once the job ends, though the done call that ended it lost the revoke", async () => {
    const { runId, jobId } = await claimedJob(48);
    const live = () =>
      rows<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM personal_access_tokens
         WHERE name = ${`steward job ${jobId}`} AND revoked_at IS NULL`);
    const { endRun } = await import('../../src/steward/runs-store.js');
    const { stewardJobCredential } = await import('../../src/steward/job.js');
    const { finalizeJobDone } = await import('../../src/jobs/index.js');
    const { db } = await import('../../src/db/client.js');
    const { jobs } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!job) throw new Error('the job row was not written');
    // the box's claim mints the job's token into its brief
    await stewardJobCredential(job);
    expect((await live())[0]?.n).toBe(1);
    // the run and the job ended, and the revoke after them did not land
    await endRun(runId, { state: 'done' });
    expect(await finalizeJobDone(job, 'steward_run_settled')).toBe(true);
    await settleOutbox();
    expect((await live())[0]?.n).toBe(0);
  });

  it("refuses anyone but the project's steward by name, and leaves the run running", async () => {
    const { runId, jobId } = await claimedJob(45);
    const owner = await as('POST', `/steward-runs/${runId}/done`, { refused: [] });
    expect([owner.status, owner.json.code]).toEqual([403, 'STEWARD_RUN_FORBIDDEN']);
    expect(await ended(runId, jobId)).toMatchObject({
      run: { state: 'running' },
      job: { status: 'dispatched' },
    });
  });
});
