/**
 * ISS-1228 round 11 — Run on an issue says what it did, or refuses by name. Core mints no step job
 * since ISS-933: a press releases the issue past a closed entry gate and wakes the project's boxes,
 * whose masters take it. Judge-27 pressed it on a project with no master and was answered 202
 * `{status: 'awaiting_release'}` while nothing took the issue.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
  openDeviceSocket,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let deviceId: string;
let ownerId: string;
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
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  deviceId = (await createTestDevice(harness.db, owner.id)).id;
  await bindTestRunner(harness.db, { projectId, deviceId });
  const { signUserToken } = await import('../../src/auth/jwt.js');
  jwt = await signUserToken(owner.id);
});

async function openIssue(): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}::uuid, 1, 'Run me', 'open', ${ownerId}::uuid)
  `);
  return id;
}

async function master(): Promise<void> {
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${runId}, ${projectId}::uuid, 'pm', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, title, started_at,
                                last_heartbeat_at)
    VALUES (${randomUUID()}, ${projectId}::uuid, ${deviceId}::uuid, ${runId}, 'master', 'running', 'a master',
            now(), now())
  `);
}

/** A run session holding the issue numbered `seq` by a lease, as a master's dispatch leaves it. */
async function runSessionHolding(seq: number, status: string): Promise<string> {
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, metadata)
    VALUES (${runId}, ${projectId}::uuid, 'system', 'running', ${JSON.stringify({ runGroup: [`ISS-${seq}`] })}::jsonb)
  `);
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, title)
    VALUES (${id}, ${projectId}::uuid, ${deviceId}::uuid, ${runId}, 'run_session', ${status}, 'run: grp-1')
  `);
  await harness.db.execute(sql`
    INSERT INTO issue_leases (project_id, issue_key, session_id, device_id, run_id)
    VALUES (${projectId}::uuid, ${`ISS-${seq}`}, ${id}::uuid, ${deviceId}::uuid, ${runId})
  `);
  return id;
}

/** A run session core has ended whose job named the issue: it holds nothing any more. */
async function endedSessionNaming(issueId: string): Promise<void> {
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${runId}, ${projectId}::uuid, 'system', 'failed')
  `);
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, title, metadata)
    VALUES (${randomUUID()}, ${projectId}::uuid, ${deviceId}::uuid, ${runId}, 'run_session', 'failed', 'run: ended',
            ${JSON.stringify({ issueId })}::jsonb)
  `);
}

async function run(issueId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${server.baseUrl}/api/issues/${issueId}/run-pipeline-step`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: '{}',
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function released(issueId: string): Promise<boolean> {
  const [row] = await harness.db.execute(
    sql`SELECT coalesce(session_context, '{}'::jsonb) ? 'runRelease' AS r FROM issues WHERE id = ${issueId}`,
  );
  return row?.r === true;
}

describe('Run says what it did, or refuses by name (ISS-1228 round 11)', () => {
  it('refuses by name where no master runs on the project, and leaves the issue as it was', async () => {
    const issueId = await openIssue();

    const { status, body } = await run(issueId);

    expect(status).toBe(409);
    expect(body.code).toBe('NO_MASTER_RUNNING');
    expect(body.message).toMatch(/No master is running on this project.*start one there/);
    expect(await released(issueId)).toBe(false);
  });

  it('answers the issue it left at Open, the masters running and that no box heard the offer', async () => {
    const issueId = await openIssue();
    await master();

    const { status, body } = await run(issueId);

    expect(status).toBe(202);
    expect(body).toEqual({
      issueId,
      status: 'open',
      released: false,
      masters: 1,
      boxesHeard: 0,
      taken: 0,
    });
  });

  // ISS-1228 round 13: judge-34 pressed Run with two boxes listening and one master; the answer's
  // boxesReached:2 was read as two boxes having taken the issue, while nothing opened on it.
  it('counts two boxes that heard the offer apart from anything taking it', async () => {
    const second = (await createTestDevice(harness.db, ownerId)).id;
    await bindTestRunner(harness.db, { projectId, deviceId: second });
    const issueId = await openIssue();
    await master();
    const sockets = [openDeviceSocket(deviceId), openDeviceSocket(second)];
    try {
      const { status, body } = await run(issueId);

      expect(status).toBe(202);
      expect(body).toMatchObject({ masters: 1, boxesHeard: 2, taken: 0 });
      for (const socket of sockets) {
        expect(socket.frames.map((f) => f.event)).toContain('master.wake');
      }
    } finally {
      for (const socket of sockets) socket.close();
    }
  });

  it('counts a live session already holding the issue as taken, and an ended one as not', async () => {
    const issueId = await openIssue();
    await master();
    await runSessionHolding(1, 'running');
    await endedSessionNaming(issueId);

    const { body } = await run(issueId);

    expect(body).toMatchObject({ taken: 1 });
  });

  it('says it released the issue where the entry gate is closed', async () => {
    await harness.db.execute(sql`
      UPDATE projects SET agent_config = '{"pipelineConfig":{"states":{"open":{"mode":"manual"}}}}'::jsonb
       WHERE id = ${projectId}::uuid
    `);
    const issueId = await openIssue();
    await master();

    const { status, body } = await run(issueId);

    expect(status).toBe(202);
    expect(body).toMatchObject({ released: true, masters: 1 });
    expect(await released(issueId)).toBe(true);
  });
});

describe("a stop reads the same on the issue's runs as on the session (ISS-1228 round 13)", () => {
  it('closes the run a person stopped, so the issue page reads it cancelled rather than running', async () => {
    const issueId = await openIssue();
    const sessionId = await runSessionHolding(1, 'running');
    const auth = { authorization: `Bearer ${jwt}` };

    const stop = await fetch(`${server.baseUrl}/api/agent-sessions/${sessionId}/cancel`, { method: 'POST', headers: auth });
    expect(stop.status).toBe(200);

    const res = await fetch(`${server.baseUrl}/api/run-journal?projectId=${projectId}&issueId=${issueId}`, { headers: auth });
    const { runs } = (await res.json()) as { runs: Array<{ status: string }> };
    expect(runs.map((r) => r.status)).toEqual(['cancelled']);
  });
});
