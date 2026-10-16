/**
 * ISS-1228 round 9 — every session read a screen counts silence on carries the silence after which
 * core ends that session, so the sessions list, the runs tab and the Pipeline page say what core will
 * do and when. Read through the routes the web reads, against a live database.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

const TEN_MIN = 10 * 60_000;

function near(actual: unknown, expected: number): void {
  expect(Math.abs((actual as number) - expected)).toBeLessThan(10_000);
}
const THREE_MIN = 3 * 60_000;

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let deviceId: string;
let jwt: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  server = await startTestServer();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  projectId = (await createTestProject(harness.db, owner.id)).id;
  deviceId = (await createTestDevice(harness.db, owner.id)).id;
  const { signUserToken } = await import('../../src/auth/jwt.js');
  jwt = await signUserToken(owner.id);
});

async function get(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${server.baseUrl}/api${path}`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function session(
  kind: string,
  opts: { runtimeState?: string; runKind?: 'system' | 'pm' } = {},
): Promise<{ id: string; runId: string }> {
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
    VALUES (${runId}, ${projectId}::uuid, ${opts.runKind ?? 'system'}, 'running', now() - interval '10 minutes')
  `);
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, title,
                                runtime_state, started_at, last_heartbeat_at)
    VALUES (${id}, ${projectId}::uuid, ${deviceId}::uuid, ${runId}, ${kind}, 'running',
            ${`a ${kind}`}, ${opts.runtimeState ?? 'working'}, now(), now() - interval '4 minutes')
  `);
  return { id, runId };
}

/** The box's runner answered just now, which is what the one-shot sweep's longer grace waits on. */
async function runnerAnswers(): Promise<void> {
  await bindTestRunner(harness.db, { projectId, deviceId });
  await harness.db.execute(
    sql`UPDATE runners SET last_seen_at = now() WHERE device_id = ${deviceId}::uuid`,
  );
}

async function statusOf(id: string): Promise<unknown> {
  const [row] = await harness.db.execute(sql`SELECT status FROM agent_sessions WHERE id = ${id}`);
  return row?.status;
}

describe("a session read carries core's own silence limit (ISS-1228 round 9)", () => {
  it("answers a run session's limit, three for a pipeline session and its residency for a waiting one on the sessions list", async () => {
    await runnerAnswers();
    const run = await session('run_session');
    const pool = await session('pipeline', { runKind: 'pm' });
    const waiting = await session('pipeline', { runtimeState: 'awaiting_input', runKind: 'pm' });

    const body = await get(`/agent-sessions?projectId=${projectId}`);
    const byId = new Map(
      (body.items as Array<{ id: string; silenceLimitMs: number | null }>).map((i) => [
        i.id,
        i.silenceLimitMs,
      ]),
    );
    // Its box answers, so the one-shot sweep waits out the grace and the run reaper's ten minutes
    // come first (ISS-1228 round 11; this read seven, three past the box's latest answer).
    near(byId.get(run.id), TEN_MIN);
    expect(byId.get(pool.id)).toBe(THREE_MIN);
    // A waiting session is not the heartbeat hop's, but its residency ends it: ten minutes and the grace.
    expect(byId.get(waiting.id)).toBe(15 * 60_000);
  });

  // ISS-1228 round 11 (judge-27): a box that kept answering moved the end three minutes past its
  // latest answer on every read, so the countdown stood at "2m 59s" for six minutes.
  it('holds the end still while the box keeps answering, and moves it only when the box goes quiet', async () => {
    await runnerAnswers();
    const run = await session('run_session');
    const endAt = async () => {
      const body = await get(`/agent-sessions/${run.id}`);
      return Date.parse(body.lastHeartbeatAt as string) + (body.silenceLimitMs as number);
    };
    const first = await endAt();
    await harness.db.execute(
      sql`UPDATE runners SET last_seen_at = now() + interval '2 minutes' WHERE device_id = ${deviceId}::uuid`,
    );
    expect(await endAt()).toBe(first);

    // The box last heard two minutes ago and silent since: the sweep may take the session a minute
    // from now, which no longer moves.
    await harness.db.execute(
      sql`UPDATE runners SET last_seen_at = now() - interval '2 minutes' WHERE device_id = ${deviceId}::uuid`,
    );
    const quiet = await endAt();
    expect(quiet).toBeLessThan(first);
    expect(await endAt()).toBe(quiet);
  });

  it('answers it on the one-session read the session page reads', async () => {
    await runnerAnswers();
    const run = await session('run_session');
    const body = await get(`/agent-sessions/${run.id}`);
    near(body.silenceLimitMs, TEN_MIN);
  });

  it("answers it on the Pipeline page's live sessions", async () => {
    await runnerAnswers();
    const run = await session('run_session');
    const body = await get(`/projects/${projectId}/sessions-and-holds`);
    const live = (body.sessions as Array<{ id: string; silenceLimitMs: number | null }>).find(
      (s) => s.id === run.id,
    );
    near(live?.silenceLimitMs, TEN_MIN);
    expect(live).toMatchObject({ jobType: null, skillName: null });
  });

  it("names a step session's job type and skill on the Pipeline page, which its title begins with", async () => {
    const { id } = await session('pipeline', { runKind: 'pm' });
    await harness.db.execute(sql`
      UPDATE agent_sessions SET title = 'forge-code: Fix the export',
             metadata = '{"jobType": "drive", "skillName": "forge-code"}'::jsonb WHERE id = ${id}
    `);
    const body = await get(`/projects/${projectId}/sessions-and-holds`);
    const live = (body.sessions as Array<{ id: string }>).find((s) => s.id === id);
    expect(live).toMatchObject({
      title: 'forge-code: Fix the export',
      jobType: 'drive',
      skillName: 'forge-code',
    });
  });

  it("answers it on the runs tab's row for the run, and null where core holds no session for it", async () => {
    await runnerAnswers();
    const run = await session('run_session');
    for (const [sessionId, runId] of [
      [run.id, randomUUID()],
      [null, randomUUID()],
    ] as const) {
      await harness.db.execute(sql`
        INSERT INTO device_run_ledger (device_id, run_id, project_id, session_id, worktree_path, boot_id,
                                       incarnation, work, issues, observed_at)
        VALUES (${deviceId}::uuid, ${runId}, ${projectId}::uuid, ${sessionId}, '/tmp/wt', 'boot-1',
                'live', 'runnable', '[]'::jsonb, now())
      `);
    }

    const body = await get(`/projects/${projectId}/run-sessions`);
    const rows = body.items as Array<{ sessionId: string | null; silenceLimitMs: number | null }>;
    near(rows.find((r) => r.sessionId === run.id)?.silenceLimitMs, TEN_MIN);
    expect(rows.find((r) => r.sessionId === null)?.silenceLimitMs).toBeNull();
  });

  it('counts the runs tab from the last heartbeat, and gives no limit where none came', async () => {
    const { id } = await session('run_session', { runKind: 'pm' });
    await harness.db.execute(sql`
      UPDATE agent_sessions SET last_heartbeat_at = NULL, started_at = now() - interval '4 minutes'
       WHERE id = ${id}
    `);
    await harness.db.execute(sql`
      INSERT INTO device_run_ledger (device_id, run_id, project_id, session_id, worktree_path, boot_id,
                                     incarnation, work, issues, observed_at)
      VALUES (${deviceId}::uuid, ${randomUUID()}, ${projectId}::uuid, ${id}, '/tmp/wt', 'boot-1',
              'live', 'runnable', '[]'::jsonb, now())
    `);

    expect((await get(`/agent-sessions/${id}`)).silenceLimitMs).toBe(TEN_MIN);
    const body = await get(`/projects/${projectId}/run-sessions`);
    const row = (
      body.items as Array<{
        sessionId: string;
        lastActivityAt: string | null;
        silenceLimitMs: number | null;
      }>
    ).find((r) => r.sessionId === id);
    expect(row?.lastActivityAt).toBeNull();
    expect(row?.silenceLimitMs).toBeNull();
  });
});

describe('the limit against each reaper that ends a session for silence (ISS-1228 round 9)', () => {
  it('reports the limit the loop monitor enforces on a chat whose escalation key holds a JSON null', async () => {
    const id = randomUUID();
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status)
      VALUES (${runId}, ${projectId}::uuid, 'interactive', 'running')
    `);
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, title, runtime_state,
                                  claude_session_id, metadata, started_at, last_heartbeat_at, updated_at)
      VALUES (${id}, ${projectId}::uuid, ${deviceId}::uuid, ${runId}, 'chat', 'running', 'a chat', 'working',
              'claude-1', '{"escalation": null}'::jsonb, now() - interval '10 minutes',
              now() - interval '4 minutes', now() - interval '4 minutes')
    `);

    const body = await get(`/agent-sessions?projectId=${projectId}`);
    const listed = (body.items as Array<{ id: string; silenceLimitMs: number | null }>).find(
      (i) => i.id === id,
    );
    expect(listed?.silenceLimitMs).toBe(THREE_MIN);

    const { reapZombieSessions } = await import('../../src/jobs/loop-monitor.js');
    await reapZombieSessions(new Date());
    expect(await statusOf(id)).toBe('failed');
  });

  it('reports three minutes for a run session carrying an escalation, which the loop monitor ends at three', async () => {
    await runnerAnswers();
    const { id } = await session('run_session');
    await harness.db.execute(sql`
      UPDATE agent_sessions SET metadata = '{"escalation": null}'::jsonb, claude_session_id = 'claude-2',
             updated_at = now() - interval '4 minutes', started_at = now() - interval '10 minutes'
       WHERE id = ${id}
    `);

    const body = await get(`/agent-sessions/${id}`);
    expect(body.silenceLimitMs).toBe(THREE_MIN);

    const { reapZombieSessions } = await import('../../src/jobs/loop-monitor.js');
    await reapZombieSessions(new Date());
    expect(await statusOf(id)).toBe('failed');
  });

  it('reports three minutes for a run session on a jobless run whose runner is not heard, which the one-shot sweep ends', async () => {
    const { id } = await session('run_session');

    expect((await get(`/agent-sessions/${id}`)).silenceLimitMs).toBe(THREE_MIN);
    const { reapOrphanedOneShotRuns } = await import('../../src/pipeline/sweeper.js');
    await reapOrphanedOneShotRuns(new Date());
    expect(await statusOf(id)).toBe('failed');
  });

  it('waits for a young run to reach the heartbeat timeout before reporting the one-shot sweep, as the sweep does', async () => {
    const { id, runId } = await session('run_session');
    await harness.db.execute(
      sql`UPDATE pipeline_runs SET started_at = now() - interval '1 minute' WHERE id = ${runId}`,
    );

    // Heard four minutes ago on a run begun one minute ago: the sweep may take it two minutes on.
    const limit = (await get(`/agent-sessions/${id}`)).silenceLimitMs as number;
    expect(limit).toBeGreaterThan(6 * 60_000 - 10_000);
    expect(limit).toBeLessThan(6 * 60_000 + 10_000);
    const { reapOrphanedOneShotRuns } = await import('../../src/pipeline/sweeper.js');
    await reapOrphanedOneShotRuns(new Date());
    expect(await statusOf(id)).toBe('running');
  });

  it("counts the loop monitor's own baseline for a session that never beat, which it leaves running at four minutes", async () => {
    const { id } = await session('pipeline', { runKind: 'pm' });
    await harness.db.execute(sql`
      UPDATE agent_sessions SET last_heartbeat_at = NULL, started_at = now() - interval '4 minutes',
             updated_at = now() - interval '1 minute' WHERE id = ${id}
    `);

    const limit = (await get(`/agent-sessions/${id}`)).silenceLimitMs as number;
    expect(Math.abs(limit - 6 * 60_000)).toBeLessThan(10_000);
    const { reapZombieSessions } = await import('../../src/jobs/loop-monitor.js');
    await reapZombieSessions(new Date());
    expect(await statusOf(id)).toBe('running');
  });

  it('reports the residency of a waiting session nobody was asked about, which ends it once past', async () => {
    const { id } = await session('pipeline', { runtimeState: 'awaiting_input', runKind: 'pm' });
    await harness.db.execute(sql`
      UPDATE agent_sessions SET last_heartbeat_at = now() - interval '16 minutes' WHERE id = ${id}
    `);

    expect((await get(`/agent-sessions/${id}`)).silenceLimitMs).toBe(15 * 60_000);
    const { reapExpiredParks } = await import('../../src/jobs/park-deadline.js');
    await reapExpiredParks(new Date());
    expect(await statusOf(id)).toBe('failed');
  });

  it('reports two hours for a parked session no job names, which the idle close ends once past', async () => {
    const { id } = await session('chat', { runKind: 'pm' });
    await harness.db.execute(sql`
      UPDATE agent_sessions SET claude_session_id = 'claude-3', started_at = now() - interval '3 hours',
             last_heartbeat_at = now() - interval '121 minutes' WHERE id = ${id}
    `);
    await harness.db.execute(sql`
      INSERT INTO agent_questions (id, project_id, agent_session_id, status, blocker_kind, steps)
      VALUES (${randomUUID()}, ${projectId}::uuid, ${id}, 'open', 'human', '[]'::jsonb)
    `);

    expect((await get(`/agent-sessions/${id}`)).silenceLimitMs).toBe(2 * 60 * 60_000);
    const { closeIdleChatSessions } = await import('../../src/pipeline/sweeper.js');
    await closeIdleChatSessions(new Date());
    expect(await statusOf(id)).toBe('completed');
  });
});

describe('the one-shot sweep, as the limit reads it (ISS-1228 round 9)', () => {
  it("ends the runner's grace when the runner itself goes quiet, as the one-shot sweep does", async () => {
    const { id } = await session('chat');
    await harness.db.execute(
      sql`UPDATE agent_sessions SET claude_session_id = 'claude-4' WHERE id = ${id}`,
    );
    await bindTestRunner(harness.db, { projectId, deviceId });
    await harness.db.execute(sql`
      UPDATE runners SET last_seen_at = now() - interval '2 minutes' WHERE device_id = ${deviceId}::uuid
    `);

    // Heard four minutes ago, its runner two: the runner's word lapses a minute from now.
    const limit = (await get(`/agent-sessions/${id}`)).silenceLimitMs as number;
    expect(Math.abs(limit - 5 * 60_000)).toBeLessThan(10_000);
    const { reapOrphanedOneShotRuns } = await import('../../src/pipeline/sweeper.js');
    await reapOrphanedOneShotRuns(new Date(Date.now() + 90_000));
    expect(await statusOf(id)).toBe('failed');
  });

  it('reads past a sibling the heartbeat hop ends first, as the sweep does once it is gone', async () => {
    const chat = await session('chat');
    await harness.db.execute(sql`
      UPDATE agent_sessions SET claude_session_id = 'claude-5', last_heartbeat_at = now() - interval '2 minutes'
       WHERE id = ${chat.id}
    `);
    const boxed = await createTestDevice(harness.db, (await createTestUser(harness.db)).id);
    await bindTestRunner(harness.db, { projectId, deviceId: boxed.id });
    await harness.db.execute(
      sql`UPDATE runners SET last_seen_at = now() WHERE device_id = ${boxed.id}::uuid`,
    );
    const pool = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, title,
                                  runtime_state, started_at, last_heartbeat_at)
      VALUES (${pool}, ${projectId}::uuid, ${boxed.id}::uuid, ${chat.runId}, 'pipeline', 'running',
              'a sibling', 'working', now() - interval '10 minutes', now() - interval '4 minutes')
    `);

    // The sibling's runner would hold the run to three minutes from now, but the heartbeat hop ends
    // the sibling now; the chat then has the heartbeat timeout from its own beat.
    near((await get(`/agent-sessions/${chat.id}`)).silenceLimitMs, THREE_MIN);
    const { reapZombieSessions } = await import('../../src/jobs/loop-monitor.js');
    await reapZombieSessions(new Date());
    expect(await statusOf(pool)).toBe('failed');
    const { reapOrphanedOneShotRuns } = await import('../../src/pipeline/sweeper.js');
    await reapOrphanedOneShotRuns(new Date(Date.now() + 70_000));
    expect(await statusOf(chat.id)).toBe('failed');
  });

  it('holds the one-shot sweep while the runner answers or a person is asked, and the sweep leaves the session be', async () => {
    const quiet = await session('run_session');
    const asked = await session('run_session');
    await harness.db.execute(sql`
      INSERT INTO agent_questions (id, project_id, agent_session_id, status, blocker_kind, steps)
      VALUES (${randomUUID()}, ${projectId}::uuid, ${asked.id}, 'open', 'human', '[]'::jsonb)
    `);
    await runnerAnswers();

    near((await get(`/agent-sessions/${quiet.id}`)).silenceLimitMs, TEN_MIN);
    expect((await get(`/agent-sessions/${asked.id}`)).silenceLimitMs).toBe(TEN_MIN);
    const { reapOrphanedOneShotRuns } = await import('../../src/pipeline/sweeper.js');
    await reapOrphanedOneShotRuns(new Date());
    expect(await statusOf(quiet.id)).toBe('running');

    await harness.db.execute(sql`DELETE FROM runners WHERE device_id = ${deviceId}::uuid`);
    const body = await get(`/agent-sessions?projectId=${projectId}`);
    const listed = new Map(
      (body.items as Array<{ id: string; silenceLimitMs: number | null }>).map((i) => [
        i.id,
        i.silenceLimitMs,
      ]),
    );
    expect(listed.get(quiet.id)).toBe(THREE_MIN);
    expect(listed.get(asked.id)).toBe(TEN_MIN);

    await reapOrphanedOneShotRuns(new Date());
    expect(await statusOf(quiet.id)).toBe('failed');
    expect(await statusOf(asked.id)).toBe('running');
  });

  it('stops counting on a child the heartbeat hop has already ended, as the master reaper does', async () => {
    const master = await session('master', { runKind: 'pm' });
    await harness.db.execute(sql`
      UPDATE agent_sessions SET last_heartbeat_at = now() - interval '11 minutes' WHERE id = ${master.id}
    `);
    const child = await session('pipeline', { runKind: 'pm' });
    await harness.db.execute(sql`
      UPDATE agent_sessions SET parent_session_id = ${master.id} WHERE id = ${child.id}
    `);

    const limit = (await get(`/agent-sessions/${master.id}`)).silenceLimitMs as number;
    expect(limit).toBeLessThan(11 * 60_000 + 10_000);
    const { reapZombieSessions } = await import('../../src/jobs/loop-monitor.js');
    await reapZombieSessions(new Date());
    const { reapSilentMasters } = await import('../../src/devices/master-reaper.js');
    await reapSilentMasters();
    expect(await statusOf(master.id)).toBe('failed');
  });

  it('ends a session no later than its owner, whose end closes what it owns', async () => {
    const master = await session('master', { runKind: 'pm' });
    const chat = await session('chat', { runKind: 'pm' });
    await harness.db.execute(sql`
      UPDATE agent_sessions SET last_heartbeat_at = now() - interval '11 minutes',
             parent_session_id = CASE WHEN id = ${chat.id}::uuid THEN ${master.id}::uuid END,
             claude_session_id = CASE WHEN id = ${chat.id}::uuid THEN 'claude-6' END
       WHERE id IN (${master.id}::uuid, ${chat.id}::uuid)
    `);

    for (const path of [`/agent-sessions/${chat.id}`, `/agent-sessions?projectId=${projectId}`]) {
      const body = await get(path);
      const items = (body.items as Array<{ id: string; silenceLimitMs: number }> | undefined) ?? [
        body as { id: string; silenceLimitMs: number },
      ];
      for (const id of [chat.id, ...(body.items ? [master.id] : [])]) {
        expect(items.find((i) => i.id === id)?.silenceLimitMs).toBeLessThan(11 * 60_000);
      }
    }
    const ended = await session('chat', { runKind: 'pm' });
    await harness.db.execute(sql`
      UPDATE agent_sessions SET status = 'completed', parent_session_id = ${master.id} WHERE id = ${ended.id}
    `);
    expect((await get(`/agent-sessions/${ended.id}`)).silenceLimitMs).toBeNull();

    const { reapSilentMasters } = await import('../../src/devices/master-reaper.js');
    await reapSilentMasters();
    expect(await statusOf(master.id)).toBe('failed');
    expect(await statusOf(chat.id)).toBe('failed');
  });

  it('waits a master out while a child it owns is heard, as the master reaper does', async () => {
    const master = await session('master');
    await harness.db.execute(sql`
      UPDATE agent_sessions SET last_heartbeat_at = now() - interval '9 minutes' WHERE id = ${master.id}
    `);
    const child = await session('run_session');
    await harness.db.execute(sql`
      UPDATE agent_sessions SET parent_session_id = ${master.id}, last_heartbeat_at = now() - interval '1 minute'
       WHERE id = ${child.id}
    `);
    // Both asked a person, so no one-shot sweep runs and the run and master reapers alone set it.
    for (const id of [master.id, child.id]) {
      await harness.db.execute(sql`
        INSERT INTO agent_questions (id, project_id, agent_session_id, status, blocker_kind, steps)
        VALUES (${randomUUID()}, ${projectId}::uuid, ${id}, 'open', 'human', '[]'::jsonb)
      `);
    }

    const limit = (await get(`/agent-sessions/${master.id}`)).silenceLimitMs as number;
    expect(limit).toBeGreaterThan(TEN_MIN + 7 * 60_000);
    expect(limit).toBeLessThan(TEN_MIN + 9 * 60_000);
  });
});
