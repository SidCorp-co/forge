/**
 * ISS-1228 round 18 (judge-53) — no job on beta reached `running` in fourteen days: a job its box
 * was working stayed `dispatched`, so its drawer read Running over "Starting · Sent to a runner".
 * A taken job whose own session core failed before it started stayed held for as long as its
 * master lived, reading Starting, and a later take would have reused that ended session.
 * Postgres evaluates every statement here; the unit lane mocks the drizzle chain.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ws/server.js', () => ({
  roomManager: { publish: vi.fn(() => 0) },
  attachWs: vi.fn(),
  closeWs: vi.fn(async () => {}),
  wsClientCount: () => 0,
}));

import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Vars = import('../../src/middleware/request-id.js').RequestIdVars;

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let deviceId: string;
let deviceToken: string;
let app: Hono<{ Variables: Vars }>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';

  const { jobEventsRoutes } = await import('../../src/jobs/events-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: Vars }>();
  app.use('*', requestId());
  app.route('/api/jobs', jobEventsRoutes as never);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  const { pairDevice } = await import('../helpers/pair-device.js');
  const issued = await pairDevice({ ownerId, name: 'box-a', platform: 'linux' });
  deviceId = issued.device.id;
  deviceToken = issued.plaintext;
});

async function newRun(): Promise<string> {
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${projectId}, 'pm', 'running')
  `);
  return runId;
}

/** A job the box has been sent, under the queued session minted for it, as `startJobForMaster` leaves it. */
async function sentJob(): Promise<{ runId: string; jobId: string; sessionId: string }> {
  const runId = await newRun();
  const jobId = randomUUID();
  const sessionId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, kind, status, dispatched_at)
    VALUES (${sessionId}, ${projectId}, ${runId}, ${deviceId}, 'pipeline', 'queued', now())
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, agent_session_id, device_id, created_by,
                      type, status, dispatched_at, acked_at, payload)
    VALUES (${jobId}, ${projectId}, ${runId}, ${sessionId}, ${deviceId}, ${ownerId}, 'drive',
            'dispatched', now(), now(), '{}'::jsonb)
  `);
  return { runId, jobId, sessionId };
}

async function post(jobId: string, events: unknown[]): Promise<number> {
  const res = await app.request(`/api/jobs/${jobId}/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  });
  return res.status;
}

async function jobStatus(jobId: string): Promise<string | undefined> {
  const rows = await harness.db.execute<{ status: string }>(
    sql`SELECT status FROM jobs WHERE id = ${jobId}`,
  );
  return rows[0]?.status;
}

async function readingOfRun(runId: string): Promise<string | null | undefined> {
  const { loadRunLivenessByRunIds } = await import('../../src/pipeline/runs-liveness.js');
  return (await loadRunLivenessByRunIds([runId])).get(runId)?.reading;
}

const starting = { kind: 'progress', data: { source: 'pool_jobs', runtimeState: 'starting' } };
const working = { kind: 'progress', data: { source: 'pool_jobs', runtimeState: 'working' } };

describe('a job its box is working is running (criteria 144, 145)', () => {
  it('stays sent, and its run reads starting, while its box reports only that it is starting', async () => {
    const { runId, jobId } = await sentJob();

    expect(await post(jobId, [starting])).toBe(200);

    expect(await jobStatus(jobId)).toBe('dispatched');
    expect(await readingOfRun(runId)).toBe('starting');
  });

  it('moves to running on the first frame that reports the agent working, its run reading running', async () => {
    const { runId, jobId } = await sentJob();

    expect(await post(jobId, [working])).toBe(200);

    expect(await jobStatus(jobId)).toBe('running');
    expect(await readingOfRun(runId)).toBe('running');
  });

  it('moves under the kernel marker, so the flip is never charged as a direct write', async () => {
    const { jobId } = await sentJob();

    expect(await post(jobId, [working])).toBe(200);

    const rows = await harness.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM unaudited_transitions WHERE entity_id = ${jobId}
    `);
    expect(rows[0]?.n).toBe(0);
  });

  it('records when its own session first reported the agent working on the attempt', async () => {
    const { runId, jobId } = await sentJob();
    const { loadAttemptsForRun } = await import('../../src/pipeline/runs-attempts.js');
    expect((await loadAttemptsForRun(runId)).attempts[0]?.ranAt).toBeNull();

    expect(await post(jobId, [working])).toBe(200);

    expect((await loadAttemptsForRun(runId)).attempts[0]?.ranAt).not.toBeNull();
  });

  it('leaves an attempt that ended before any box started it with no ran time', async () => {
    const { runId, jobId } = await sentJob();
    await harness.db.execute(sql`
      UPDATE jobs SET status = 'failed', finished_at = now(), error = 'dispatch_unclaimed'
       WHERE id = ${jobId}
    `);
    const { loadAttemptsForRun } = await import('../../src/pipeline/runs-attempts.js');
    expect((await loadAttemptsForRun(runId)).attempts[0]).toMatchObject({
      status: 'failed',
      ranAt: null,
    });
  });
});

describe('a chat waiting on its person (criterion 147)', () => {
  it('reads waiting, never running, whatever it last checked in', async () => {
    const runId = await newRun();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, kind, status,
                                  last_heartbeat_at)
      VALUES (${randomUUID()}, ${projectId}, ${runId}, ${deviceId}, 'chat', 'idle', now())
    `);
    expect(await readingOfRun(runId)).toBe('waiting');
  });

  it('reads running once its turn runs', async () => {
    const runId = await newRun();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, kind, status,
                                  last_heartbeat_at)
      VALUES (${randomUUID()}, ${projectId}, ${runId}, ${deviceId}, 'chat', 'running', now())
    `);
    expect(await readingOfRun(runId)).toBe('running');
  });
});

/** A job a live master holds, its own session minted for the take, as `prepareJobForMaster` leaves it. */
async function takenJob(own: { status: string; endedSecondsAgo: number; heldSecondsAgo: number }) {
  const runId = await newRun();
  const masterRun = await newRun();
  const master = randomUUID();
  const ownSession = randomUUID();
  const jobId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, kind, status,
                                started_at, last_heartbeat_at)
    VALUES (${master}, ${projectId}, ${masterRun}, ${deviceId}, 'master', 'running', now(), now())
  `);
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, kind, status,
                                parent_session_id, dispatched_at, created_at, updated_at)
    VALUES (${ownSession}, ${projectId}, ${runId}, ${deviceId}, 'pipeline', ${own.status},
            ${master}, now() - make_interval(secs => ${own.heldSecondsAgo + 60}),
            now() - make_interval(secs => ${own.heldSecondsAgo + 60}),
            now() - make_interval(secs => ${own.endedSecondsAgo}))
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, agent_session_id, created_by, type, status,
                      held_by, held_at, payload)
    VALUES (${jobId}, ${projectId}, ${runId}, ${ownSession}, ${ownerId}, 'drive', 'queued',
            ${master}, now() - make_interval(secs => ${own.heldSecondsAgo}), '{}'::jsonb)
  `);
  return { runId, jobId, master, ownSession };
}

async function held(jobId: string): Promise<string | null | undefined> {
  const rows = await harness.db.execute<{ held_by: string | null }>(
    sql`SELECT held_by FROM jobs WHERE id = ${jobId}`,
  );
  return rows[0]?.held_by;
}

describe("a dead session's hold is given back (criteria 148, 149)", () => {
  it('returns to the queue a taken job whose own session core ended during the take, reading queued', async () => {
    const { runId, jobId } = await takenJob({
      status: 'failed',
      endedSecondsAgo: 30,
      heldSecondsAgo: 300,
    });
    expect(await readingOfRun(runId)).toBe('starting');
    const { reapDeadMasterHolds } = await import('../../src/devices/master-reaper.js');

    expect(await reapDeadMasterHolds()).toBe(1);

    expect(await held(jobId)).toBeNull();
    expect(await jobStatus(jobId)).toBe('queued');
    expect(await readingOfRun(runId)).toBe('queued');
  });

  it('keeps the hold while the take its own session carries is still live', async () => {
    const { jobId, master } = await takenJob({
      status: 'queued',
      endedSecondsAgo: 30,
      heldSecondsAgo: 300,
    });
    const { reapDeadMasterHolds } = await import('../../src/devices/master-reaper.js');

    expect(await reapDeadMasterHolds()).toBe(0);

    expect(await held(jobId)).toBe(master);
  });

  it('never counts a session that ended before this take began', async () => {
    const { jobId, master } = await takenJob({
      status: 'failed',
      endedSecondsAgo: 600,
      heldSecondsAgo: 30,
    });
    const { reapDeadMasterHolds } = await import('../../src/devices/master-reaper.js');

    expect(await reapDeadMasterHolds()).toBe(0);

    expect(await held(jobId)).toBe(master);
  });

  it('takes the job again in a new session, never the one core ended', async () => {
    const { jobId, ownSession } = await takenJob({
      status: 'failed',
      endedSecondsAgo: 30,
      heldSecondsAgo: 300,
    });
    const { ensureAgentSessionForJob } = await import('../../src/jobs/agent-session-link.js');
    const { jobs } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const [job] = await harness.db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!job) throw new Error('job vanished');
    const resume = {
      resumed: false,
      dropReason: null,
      priorClaudeSessionId: null,
      priorDeviceId: null,
      pinDeviceId: null,
    } as never;

    const fresh = await ensureAgentSessionForJob({ ...job, heldBy: null }, { repoPath: null, resume });

    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(ownSession);
    const rows = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM agent_sessions WHERE id = ${fresh}`,
    );
    expect(rows[0]?.status).toBe('queued');
  });

  it('keeps the session a take is still using', async () => {
    const { jobId, ownSession } = await takenJob({
      status: 'queued',
      endedSecondsAgo: 30,
      heldSecondsAgo: 300,
    });
    const { ensureAgentSessionForJob } = await import('../../src/jobs/agent-session-link.js');
    const { jobs } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const [job] = await harness.db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!job) throw new Error('job vanished');

    const kept = await ensureAgentSessionForJob(job, { repoPath: null, resume: {} as never });

    expect(kept).toBe(ownSession);
  });
});
