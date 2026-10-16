/**
 * ISS-1228 round 9 — every session read a screen counts silence on carries the silence after which
 * core ends that session, so the sessions list, the runs tab and the Pipeline page say what core will
 * do and when. Read through the routes the web reads, against a live database.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
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
  runtimeState = 'working',
): Promise<{ id: string; runId: string }> {
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${projectId}::uuid, 'system', 'running')
  `);
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, title,
                                runtime_state, started_at, last_heartbeat_at)
    VALUES (${id}, ${projectId}::uuid, ${deviceId}::uuid, ${runId}, ${kind}, 'running',
            ${`a ${kind}`}, ${runtimeState}, now(), now() - interval '4 minutes')
  `);
  return { id, runId };
}

describe("a session read carries core's own silence limit (ISS-1228 round 9)", () => {
  it('answers ten minutes for a run session and three for a pipeline session on the sessions list', async () => {
    const run = await session('run_session');
    const pool = await session('pipeline');
    const waiting = await session('pipeline', 'awaiting_input');

    const body = await get(`/agent-sessions?projectId=${projectId}`);
    const byId = new Map(
      (body.items as Array<{ id: string; silenceLimitMs: number | null }>).map((i) => [
        i.id,
        i.silenceLimitMs,
      ]),
    );
    expect(byId.get(run.id)).toBe(TEN_MIN);
    expect(byId.get(pool.id)).toBe(THREE_MIN);
    expect(byId.get(waiting.id)).toBeNull();
  });

  it('answers it on the one-session read the session page reads', async () => {
    const run = await session('run_session');
    const body = await get(`/agent-sessions/${run.id}`);
    expect(body.silenceLimitMs).toBe(TEN_MIN);
  });

  it("answers it on the Pipeline page's live sessions", async () => {
    const run = await session('run_session');
    const body = await get(`/projects/${projectId}/sessions-and-holds`);
    const live = (body.sessions as Array<{ id: string; silenceLimitMs: number | null }>).find(
      (s) => s.id === run.id,
    );
    expect(live?.silenceLimitMs).toBe(TEN_MIN);
  });

  it("answers it on the runs tab's row for the run, and null where core holds no session for it", async () => {
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
    expect(rows.find((r) => r.sessionId === run.id)?.silenceLimitMs).toBe(TEN_MIN);
    expect(rows.find((r) => r.sessionId === null)?.silenceLimitMs).toBeNull();
  });

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
    const [row] = await harness.db.execute(sql`SELECT status FROM agent_sessions WHERE id = ${id}`);
    expect(row?.status).toBe('failed');
  });

  it('reports three minutes for a run session carrying an escalation, which the loop monitor ends at three', async () => {
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
    const [row] = await harness.db.execute(sql`SELECT status FROM agent_sessions WHERE id = ${id}`);
    expect(row?.status).toBe('failed');
  });
});
