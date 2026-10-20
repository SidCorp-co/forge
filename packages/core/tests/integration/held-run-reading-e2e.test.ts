/**
 * ISS-1228 round 19 (judge-57) — a held job read "Nothing working", a run session that never checked
 * in read Running, a person's cancel read an earlier take's queue timeout, a question stop read
 * Unclassified. Core answers each from the rows it writes, the same on every read of the run.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

  const { agentSessionRoutes } = await import('../../src/agent-sessions/routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: Vars }>();
  app.use('*', requestId());
  app.route('/api/agent-sessions', agentSessionRoutes as never);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  await harness.db.execute(sql`UPDATE users SET display_name = 'Sam Owner' WHERE id = ${ownerId}`);
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  const { pairDevice } = await import('../helpers/pair-device.js');
  const issued = await pairDevice({ ownerId, name: 'box-b', platform: 'linux' });
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

async function summary(runId: string) {
  const { loadPipelineRunSummary } = await import('../../src/pipeline/runs-rollup.js');
  const s = await loadPipelineRunSummary(runId);
  if (!s) throw new Error('no summary');
  return s;
}

describe('a held job is a reading of its own (criteria 135, 138, 163, 164)', () => {
  async function heldRun(reason: string, autoRelease: boolean): Promise<string> {
    const runId = await newRun();
    const hold = JSON.stringify({
      __hold: { reason, heldAt: new Date().toISOString(), autoRelease },
    });
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, created_by, type, status, failure_reason,
                        payload, queued_at)
      VALUES (${randomUUID()}, ${projectId}, ${runId}, ${ownerId}, 'drive', 'failed', 'dispatch_unclaimed',
              '{}'::jsonb, now() - interval '20 minutes')
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, created_by, type, status, failure_reason,
                        payload, queued_at)
      VALUES (${randomUUID()}, ${projectId}, ${runId}, ${ownerId}, 'drive', 'held', ${reason},
              ${hold}::jsonb, now() - interval '10 minutes')
    `);
    return runId;
  }

  it('reads a run whose only live job core holds as held, saying it resumes itself', async () => {
    const runId = await heldRun('all_devices_exhausted', true);
    const s = await summary(runId);
    expect(s.reading).toBe('held');
    expect(s.liveJobs).toBe(0);
    expect(s.hold).toMatchObject({ reason: 'all_devices_exhausted', resumesItself: true });
    expect(s.attempts.at(-1)?.hold).toMatchObject({
      reason: 'all_devices_exhausted',
      resumesItself: true,
    });
  });

  it('says a hold on a spent retry budget does not resume itself', async () => {
    const s = await summary(await heldRun('retry_rounds_exhausted', false));
    expect(s.reading).toBe('held');
    expect(s.hold?.resumesItself).toBe(false);
  });

  it('answers the same reading on the issue journal read', async () => {
    const runId = await heldRun('all_devices_exhausted', true);
    const { loadRunLivenessByRunIds } = await import('../../src/pipeline/runs-liveness.js');
    const { groupByRun } = await import('../../src/pipeline/run-journal-routes.js');
    const live = await loadRunLivenessByRunIds([runId]);
    const journal = groupByRun(
      [
        {
          id: runId,
          kind: 'pm',
          status: 'running',
          startedAt: new Date(),
          finishedAt: null,
          ordinal: 1,
          group: null,
          sessionId: null,
        },
      ],
      [],
      randomUUID(),
      new Map(),
      live,
    );
    expect(journal.runs[0]).toMatchObject({ reading: 'held', hold: { resumesItself: true } });
  });
});

describe('a run session is Starting until it checks in (criteria 135, 166, 180)', () => {
  it('opens with no start, reads starting with when core ends it, then running from its first check-in', async () => {
    const { openRunSession } = await import('../../src/devices/run-session.js');
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${randomUUID()}, ${projectId}, 7, 'seventh', 'in_progress', ${ownerId})
    `);
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, name, type, status, last_seen_at)
      VALUES (${randomUUID()}, ${projectId}, ${deviceId}, 'r1', 'claude-code', 'online', now())
    `);
    const opened = await openRunSession({
      deviceId,
      projectId,
      issueKeys: ['ISS-7'],
      name: 'iss-7',
    });
    const before = await summary(opened.runId);
    expect(before.reading).toBe('starting');
    expect(before.runningSince).toBeNull();
    expect(before.checkInBy).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const ends = Date.parse(before.checkInBy ?? '') - Date.now();
    expect(ends).toBeGreaterThan(9 * 60_000);
    expect(ends).toBeLessThanOrEqual(10 * 60_000);

    const { roomManager } = await import('../../src/ws/server.js');
    const publish = vi.spyOn(roomManager, 'publish');
    const startedFlags = () =>
      publish.mock.calls
        .filter(([room]) => room === `project:${projectId}`)
        .map(([, p]) => p as { event: string; data: { started?: boolean } })
        .filter((p) => p.event === 'agent-session.updated')
        .map((p) => p.data.started === true);

    const res = await app.request(`/api/agent-sessions/${opened.sessionId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'running' }),
    });
    expect(res.status).toBe(200);

    const after = await summary(opened.runId);
    expect(after.reading).toBe('running');
    expect(after.checkInBy).toBeNull();
    const first = after.runningSince;
    expect(first).not.toBeNull();
    // An ISO time every reader parses, never Postgres's own text.
    expect(first).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

    // A later check-in never moves the start.
    await app.request(`/api/agent-sessions/${opened.sessionId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'running' }),
    });
    expect((await summary(opened.runId)).runningSince).toBe(first);
    // Only the first check-in says the run started, so the run's readers re-read on it alone.
    expect(startedFlags()).toEqual([true, false]);
    publish.mockRestore();
  });
});

describe('a run a box reports blocked reads blocked (criterion 169)', () => {
  it('reads blocked ahead of the job it runs, with who holds the wait', async () => {
    const runId = await newRun();
    const sessionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, kind, status,
                                  started_at, last_heartbeat_at)
      VALUES (${sessionId}, ${projectId}, ${runId}, ${deviceId}, 'run_session', 'running', now(), now())
    `);
    await harness.db.execute(sql`
      INSERT INTO device_run_ledger (device_id, run_id, project_id, session_id, worktree_path, boot_id,
                                     incarnation, work, blocker_kind, issues, observed_at, work_since)
      VALUES (${deviceId}, 'box-run-1', ${projectId}, ${sessionId}, '/w/iss-1', 'b1', 'live', 'blocked',
              'human', '[]'::jsonb, now(), now())
    `);
    const s = await summary(runId);
    expect(s.reading).toBe('blocked');
    expect(s.block).toEqual({ blockerKind: 'human', parked: false });

    const { readProjectRunSessions } = await import('../../src/devices/run-ledger.js');
    expect((await readProjectRunSessions(projectId))[0]?.pipelineRunId).toBe(runId);
  });
});

describe('a cancel reads as a cancel, by whom (criterion 173)', () => {
  it("records the person's cancel on the job and never reads an earlier take's queue timeout", async () => {
    const runId = await newRun();
    const deadTake = randomUUID();
    const jobId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, kind, status, failure_reason)
      VALUES (${deadTake}, ${projectId}, ${runId}, ${deviceId}, 'pipeline', 'failed', 'queue_timeout')
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, agent_session_id, created_by, type, status, payload)
      VALUES (${jobId}, ${projectId}, ${runId}, ${deadTake}, ${ownerId}, 'drive', 'queued', '{}'::jsonb)
    `);
    const { cancelJob } = await import('../../src/jobs/cancel-job.js');
    await cancelJob(jobId, {
      actorUserId: ownerId,
      actorAgency: 'human',
      reason: 'test',
      source: 'rest',
    });

    const [row] = await harness.db.execute<{ failure_reason: string | null }>(
      sql`SELECT failure_reason FROM jobs WHERE id = ${jobId}`,
    );
    expect(row?.failure_reason).toBe('user_cancelled');
    const attempt = (await summary(runId)).attempts[0];
    expect(attempt?.failureCause).toBeNull();
    expect(attempt?.cancelledBy).toEqual({ kind: 'person', userId: ownerId, name: 'Sam Owner' });
  });

  it("names the person who cancelled the run on a job the run's cancel swept", async () => {
    const runId = await newRun();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, created_by, type, status, payload)
      VALUES (${randomUUID()}, ${projectId}, ${runId}, ${ownerId}, 'drive', 'queued', '{}'::jsonb)
    `);
    const { cancelPipelineRun } = await import('../../src/pipeline/runs-control.js');
    await cancelPipelineRun(runId, {
      actorUserId: ownerId,
      actorAgency: 'human',
      parkIssue: false,
    });
    const attempt = (await summary(runId)).attempts[0];
    expect(attempt?.status).toBe('cancelled');
    expect(attempt?.cancelledBy).toEqual({ kind: 'person', userId: ownerId, name: 'Sam Owner' });
  });
});

describe("a dead take's session is dropped when its hold is given back (criterion 173)", () => {
  it('unlinks the session core ended, so the job reads no cause of it', async () => {
    const runId = await newRun();
    const masterRun = await newRun();
    const master = randomUUID();
    const ownSession = randomUUID();
    const jobId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, kind, status, started_at, last_heartbeat_at)
      VALUES (${master}, ${projectId}, ${masterRun}, ${deviceId}, 'master', 'running', now(), now())
    `);
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, kind, status, failure_reason,
                                  parent_session_id, created_at, updated_at)
      VALUES (${ownSession}, ${projectId}, ${runId}, ${deviceId}, 'pipeline', 'failed', 'queue_timeout',
              ${master}, now() - interval '6 minutes', now() - interval '30 seconds')
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, agent_session_id, created_by, type, status,
                        held_by, held_at, payload)
      VALUES (${jobId}, ${projectId}, ${runId}, ${ownSession}, ${ownerId}, 'drive', 'queued',
              ${master}, now() - interval '5 minutes', '{}'::jsonb)
    `);
    const { reapDeadMasterHolds } = await import('../../src/devices/master-reaper.js');
    expect(await reapDeadMasterHolds()).toBe(1);
    const [row] = await harness.db.execute<{ agent_session_id: string | null }>(
      sql`SELECT agent_session_id FROM jobs WHERE id = ${jobId}`,
    );
    expect(row?.agent_session_id).toBeNull();
  });
});

describe('a job no box took reads its cause, never unclassified (criterion 160)', () => {
  it("classifies the sweeper's ack miss on a job no session ended", async () => {
    const runId = await newRun();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, device_id, created_by, type, status, error,
                        failure_reason, failure_kind, payload, finished_at)
      VALUES (${randomUUID()}, ${projectId}, ${runId}, ${deviceId}, ${ownerId}, 'drive', 'failed',
              'dispatch_unclaimed',
              'dispatch never claimed by a runner (no ack / no started event within grace window)',
              'infra', '{}'::jsonb, now())
    `);
    const attempt = (await summary(runId)).attempts[0];
    expect(attempt?.failureCause).toBe('runner_unreachable');
  });
});

describe('a retry names the box it targets (criterion 172)', () => {
  it('reads the name of a target box no attempt ran on, never its id', async () => {
    const runId = await newRun();
    const payload = JSON.stringify({
      _autoRetry: { round: 1, target: deviceId, tries: 1, done: [] },
    });
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, created_by, type, status, payload)
      VALUES (${randomUUID()}, ${projectId}, ${runId}, ${ownerId}, 'drive', 'queued', ${payload}::jsonb)
    `);
    const { retrySummary } = await summary(runId);
    expect(retrySummary).toMatchObject({ targetDeviceId: deviceId, targetDeviceName: 'box-b' });
  });
});
