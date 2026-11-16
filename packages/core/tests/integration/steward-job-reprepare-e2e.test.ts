/**
 * A steward job prepared twice (ISS-972, Sentry FORGE-DEV-CORE-2). The box's prepare mints the
 * steward account's token for the job into its brief, under the one name `steward job <jobId>`, and
 * `pat_user_name_uniq` keeps that name unique among live tokens. A prepare whose answer was lost, or
 * whose hold was released before the start, leaves that token live; the next prepare of the job must
 * still brief it with a working token, never fail the insert.
 *
 * - The second prepare answers 200 with a token that works, and the first one still works: a pane
 *   briefed with it may still be working the job (ISS-1004, FB-511), so only the job's end takes it.
 * - Each prepare's token has a name of its own under the job's, and the job's end revokes every one.
 * - A prepare whose steward cannot act on the project is refused by name, not INTERNAL_ERROR.
 * - A held job whose own session ended unstarted while its master lives is given back by the hold
 *   sweep, naming the session and why, and prepares again on a fresh session (ISS-1258); one whose
 *   session is still starting keeps its hold.
 *
 * @direct-test-of packages/core/src/steward/job.ts
 * @direct-test-of packages/core/src/steward/credential.ts
 * @direct-test-of packages/core/src/jobs/prepare-claimed-job.ts
 * @direct-test-of packages/core/src/jobs/master-holds.ts
 * @direct-test-of packages/core/src/jobs/agent-session-link.ts
 * @direct-test-of packages/core/src/devices/master-reaper.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import {
  closeWorld,
  type Doc,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';

let projectId = '';
let ownerId = '';
let boxPat = '';
let sessionId = '';
let boxId = '';
let seq = 0;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  const box = await createTestDevice(ownerId);
  boxId = box;
  await bindTestRunner(projectId, box);
  boxPat = (
    await mintPat({
      permissions: ['*'],
      userId: ownerId,
      name: 'box-reprepare',
      deviceId: box,
      projectIds: [projectId],
    })
  ).plaintext;
  const master = await call(boxPat, 'POST', '/api/devices/me/master-session', {
    projectId,
    name: 'steward-reprepare-master',
    maxJobPanes: 1,
  });
  expect(master.status, JSON.stringify(master.body)).toBeLessThan(300);
  sessionId = master.body.sessionId as string;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

async function call(token: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await api(token, method, path, body);
  return { status: res.status, body: res.body as Doc };
}

/** A queued steward job for a running release follow-through run, as the steward dispatch makes it. */
async function stewardJob(): Promise<{ runId: string; jobId: string }> {
  seq += 1;
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
  const { enqueueStewardJob } = await import('../../src/steward/job.js');
  const { stewardRuns } = await import('../../src/db/schema-steward-runs.js');
  const { eq } = await import('drizzle-orm');
  const [run] = await db.select().from(stewardRuns).where(eq(stewardRuns.id, runId));
  if (!run) throw new Error('the steward run row was not written');
  const started = await enqueueStewardJob(run, ['release_followthrough']);
  if (!started.ok) throw new Error(started.failure);
  await rows(sql`UPDATE steward_runs SET job_id = ${started.jobId} WHERE id = ${runId}`);
  return { runId, jobId: started.jobId };
}

const prepare = (jobId: string) =>
  call(boxPat, 'POST', '/api/devices/me/pool/prepare', { jobId, sessionId });

/** The box gives the held job back unstarted: its answer was lost, or its pane restarted. */
const giveBack = (jobId: string) =>
  call(boxPat, 'POST', '/api/devices/me/pool/release', { jobId, sessionId });

/** The steward token a prepared brief carries; never printed. */
function briefToken(prepared: Doc): string {
  const brief = (prepared.prepared as { promptString?: string } | undefined)?.promptString ?? '';
  const token = /Authorization: Bearer (\S+?)"/.exec(brief)?.[1];
  if (!token) throw new Error('the prepared brief carries no steward token');
  return token;
}

/** The job's live steward tokens, one per prepare, each named under `steward job <jobId>`. */
const liveNamed = async (jobId: string) =>
  (
    await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM personal_access_tokens
       WHERE (name = ${`steward job ${jobId}`} OR name LIKE ${`steward job ${jobId} #%`})
         AND revoked_at IS NULL`)
  )[0]?.n;

/** Whether a token is let through a project door the steward account can read. */
const works = async (token: string) =>
  (await call(token, 'GET', `/api/projects/${projectId}`)).status === 200;

describe('a steward job prepared twice (ISS-972)', () => {
  it('briefs the second prepare with a working token, and leaves the first working', async () => {
    const { jobId } = await stewardJob();
    const first = await prepare(jobId);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const firstToken = briefToken(first.body);
    expect(await works(firstToken)).toBe(true);
    expect(await liveNamed(jobId)).toBe(1);

    const back = await giveBack(jobId);
    expect(back.status, JSON.stringify(back.body)).toBeLessThan(300);

    const second = await prepare(jobId);
    expect(
      [second.status, (second.body.error as { code?: string } | undefined)?.code ?? null],
      JSON.stringify(second.body),
    ).toEqual([200, null]);
    const secondToken = briefToken(second.body);
    expect(secondToken).not.toBe(firstToken);
    expect(await works(secondToken)).toBe(true);
    // ISS-1004: a pane briefed with the first may still be working the job; nothing tells it
    expect(await works(firstToken)).toBe(true);
    expect(await liveNamed(jobId)).toBe(2);
  });

  it("mints one token per prepare, and the job's end revokes every one", async () => {
    const { runId, jobId } = await stewardJob();
    let token = '';
    const earlier: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      const prepared = await prepare(jobId);
      expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
      if (token) earlier.push(token);
      token = briefToken(prepared.body);
      expect(await liveNamed(jobId)).toBe(round + 1);
      if (round < 2) await giveBack(jobId);
    }
    const started = await call(boxPat, 'POST', '/api/devices/me/pool/start', { jobId, sessionId });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const done = await call(
      token,
      'POST',
      `/api/projects/${projectId}/steward-runs/${runId}/done`,
      { refused: [] },
    );
    expect([done.status, done.body], JSON.stringify(done.body)).toEqual([200, { state: 'done' }]);
    expect(await liveNamed(jobId)).toBe(0);
    expect(await works(token)).toBe(false);
    for (const one of earlier) expect(await works(one)).toBe(false);
  });

  // ISS-1004 (FB-511, sidpeak job 905740f6): the start's own `queued → dispatched` transition reached
  // the steward's consumer, which read it as the job's end, revoked the token and failed the run, so
  // the agent's reads answered INVALID_TOKEN minutes in and its done call was refused
  it('keeps the token working through the start, until the run’s own done call', async () => {
    const { runId, jobId } = await stewardJob();
    const prepared = await prepare(jobId);
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const token = briefToken(prepared.body);
    const started = await call(boxPat, 'POST', '/api/devices/me/pool/start', { jobId, sessionId });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await settleOutbox();
    expect(await works(token)).toBe(true);
    const [run] = await rows<{ state: string }>(
      sql`SELECT state FROM steward_runs WHERE id = ${runId}`,
    );
    expect(run?.state).toBe('running');
    const done = await call(
      token,
      'POST',
      `/api/projects/${projectId}/steward-runs/${runId}/done`,
      { refused: [] },
    );
    expect([done.status, done.body], JSON.stringify(done.body)).toEqual([200, { state: 'done' }]);
    expect(await works(token)).toBe(false);
  });

  it('refuses by name a prepare whose steward cannot act on the project, and mints nothing', async () => {
    const { jobId } = await stewardJob();
    const { stewardAccountOf } = await import('../../src/steward/account.js');
    const stewardId = await stewardAccountOf(projectId);
    // the steward account was taken off the project, so no token can be minted as it there
    const [member] = await rows<{ row: unknown }>(sql`
      DELETE FROM project_members pm WHERE pm.project_id = ${projectId} AND pm.user_id = ${stewardId}
      RETURNING to_jsonb(pm) AS row`);
    expect(member).toBeDefined();
    try {
      const refused = await prepare(jobId);
      expect(
        [refused.status, (refused.body.error as { code?: string } | undefined)?.code],
        JSON.stringify(refused.body),
      ).toEqual([409, 'POOL_STEWARD_CANNOT_ACT']);
      expect(JSON.stringify(refused.body)).toContain('steward');
      expect(await liveNamed(jobId)).toBe(0);
      const [job] = await rows<{ status: string; held_by: string | null }>(sql`
        SELECT status, held_by FROM jobs WHERE id = ${jobId}`);
      expect(job).toEqual({ status: 'queued', held_by: null });
    } finally {
      await rows(sql`
        INSERT INTO project_members
        SELECT * FROM jsonb_populate_record(NULL::project_members, ${JSON.stringify(member?.row)}::jsonb)`);
    }
  });
});

/** The pipeline session a prepare minted for the job, which the box runs it under. */
function preparedSession(prepared: Doc): string {
  const id = (prepared.prepared as { agentSessionId?: string } | undefined)?.agentSessionId;
  if (!id) throw new Error('the prepare answered no agent session');
  return id;
}

const sessionRow = async (id: string) =>
  (
    await rows<{ status: string; failure_reason: string | null; started_at: Date | null }>(sql`
      SELECT status, failure_reason, started_at FROM agent_sessions WHERE id = ${id}`)
  )[0];

const jobRow = async (jobId: string) =>
  (
    await rows<{ status: string; held_by: string | null; agent_session_id: string | null }>(sql`
      SELECT status, held_by, agent_session_id FROM jobs WHERE id = ${jobId}`)
  )[0];

/**
 * The queue hop over one session, as the loop monitor runs it: `queueCutoff` is the instant a
 * session dispatched before, and never heard from, has waited too long.
 */
async function queueHop(session: string, queueCutoff: Date): Promise<void> {
  const { reapQueueHop } = await import('../../src/jobs/queue-hop.js');
  const { agentSessions } = await import('../../src/db/schema.js');
  const { eq } = await import('drizzle-orm');
  await reapQueueHop({
    now: new Date(),
    queueCutoff,
    quietCutoff: new Date(0),
    projectFilter: eq(agentSessions.id, session),
  });
}

/** One pass of the hold sweep, with what it logged about `jobId`. */
async function sweepHolds(jobId: string): Promise<{ logged: Array<Record<string, unknown>> }> {
  const { reapDeadMasterHolds } = await import('../../src/devices/master-reaper.js');
  const { logger } = await import('../../src/lib/logger.js');
  const warn = vi.spyOn(logger, 'warn');
  try {
    await reapDeadMasterHolds();
    const logged = warn.mock.calls
      .map(([fields]) => fields as unknown)
      .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
      .filter((f) => f.jobId === jobId);
    return { logged };
  } finally {
    warn.mockRestore();
  }
}

/** The subagent slots this project's runs and steward jobs hold on the box: what `RUN_SLOT_UNAVAILABLE` reads. */
async function slotsInUse(): Promise<number> {
  const { readBoxSlots } = await import('../../src/devices/run-slots-read.js');
  const box = await readBoxSlots(boxId);
  return box.projects.find((p) => p.projectId === projectId)?.inUse ?? 0;
}

describe('a held job whose own session ended unstarted (ISS-1258)', () => {
  // forge-dev 2026-11-16: steward job bace631e, held by live master 739cd707, kept its hold for two
  // hours after its session e1d4b5ef failed queue_timeout, and the project's run slot with it
  it('is given back naming the session and why, and prepares again on a fresh session', async () => {
    const { runId, jobId } = await stewardJob();
    const first = await prepare(jobId);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const ended = preparedSession(first.body);

    await queueHop(ended, new Date(Date.now() + 60_000));
    expect(await sessionRow(ended)).toEqual({
      status: 'failed',
      failure_reason: 'queue_timeout',
      started_at: null,
    });
    expect((await sessionRow(sessionId))?.status).toBe('running');
    expect(await jobRow(jobId)).toMatchObject({ status: 'queued', held_by: sessionId });

    const { logged } = await sweepHolds(jobId);
    expect(await jobRow(jobId)).toMatchObject({ status: 'queued', held_by: null });
    expect(logged).toEqual([
      expect.objectContaining({
        masterSessionId: sessionId,
        masterStatus: 'running',
        sessionId: ended,
        sessionStatus: 'failed',
        failureReason: 'queue_timeout',
      }),
    ]);

    const inUse = await slotsInUse();
    const again = await prepare(jobId);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const fresh = preparedSession(again.body);
    expect(fresh).not.toBe(ended);
    expect((await sessionRow(fresh))?.status).toBe('queued');
    expect((await sessionRow(ended))?.status).toBe('failed');

    const started = await call(boxPat, 'POST', '/api/devices/me/pool/start', { jobId, sessionId });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(await jobRow(jobId)).toMatchObject({ status: 'dispatched', agent_session_id: fresh });
    const done = await call(
      briefToken(again.body),
      'POST',
      `/api/projects/${projectId}/steward-runs/${runId}/done`,
      { refused: [] },
    );
    expect([done.status, done.body], JSON.stringify(done.body)).toEqual([200, { state: 'done' }]);
    expect(await slotsInUse()).toBe(inUse - 1);
  });

  it('keeps the hold of a job whose session is still starting inside the queue window', async () => {
    const { jobId } = await stewardJob();
    const prepared = await prepare(jobId);
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const starting = preparedSession(prepared.body);

    const { getLoopThresholds } = await import('../../src/jobs/loop-monitor-thresholds.js');
    await queueHop(starting, new Date(Date.now() - getLoopThresholds().queueMs));
    const { logged } = await sweepHolds(jobId);

    expect((await sessionRow(starting))?.status).toBe('queued');
    expect(await jobRow(jobId)).toMatchObject({
      status: 'queued',
      held_by: sessionId,
      agent_session_id: starting,
    });
    expect(logged).toEqual([]);
    await giveBack(jobId);
  });
});
