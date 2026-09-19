/**
 * ISS-1101 — core reads `running` only off a report that a turn began.
 *
 * The unit lane for `events-routes.ts` mocks the whole drizzle chain: it can
 * see which keys the `.set()` payload carried and nothing else. The row that
 * comes back is a literal the mock was handed, so "the session is still
 * `queued` afterwards" and "no flip was announced" both pass there against any
 * SQL whatever — planted, the `startedRunning` flag left reading
 * `prev.status = 'queued'` alone stayed green in that lane. Both are asserted
 * here, where Postgres evaluates the statement.
 *
 * The CONCURRENT half of the exactly-once broadcast is not here and deliberately
 * not repeated: `job-event-ingest-writes.test.ts` already holds a deterministic
 * contention case for it, which pins both requests at the heartbeat with its own
 * `FOR UPDATE` so the interleaving always happens. A naive two-`Promise.all`
 * version was written here and measured: with the CTE's `FOR UPDATE` removed it
 * stayed GREEN, because the two statements never overlapped. It was deleted
 * rather than kept beside a comment claiming it caught that.
 *
 * The frame that matters is the pane lane's own beat,
 * `{"source":"pool_jobs","state":"running"}` — no `runtimeState` key at all,
 * and the only thing that lane sends before a turn runs
 * (`daemon/pool_jobs.rs#CoreReport::progress`). Measured sid-desk 2026-09-18:
 * thirty-one minutes of `running` over a pane whose prompt sat unsubmitted.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const publish = vi.fn((_room: string, _payload: unknown) => 0);
vi.mock('../../src/ws/server.js', () => ({
  roomManager: { publish },
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
  publish.mockClear();
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  const { pairDevice } = await import('../helpers/pair-device.js');
  const issued = await pairDevice({ ownerId, name: 'd1', platform: 'linux' });
  deviceId = issued.device.id;
  deviceToken = issued.plaintext;
});

async function seed(sessionStatus: 'queued' | 'running'): Promise<{
  jobId: string;
  sessionId: string;
}> {
  const jobId = randomUUID();
  const runId = randomUUID();
  const sessionId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${projectId}, 'interactive', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, status, dispatched_at, metadata)
    VALUES (${sessionId}, ${projectId}, ${runId}, ${deviceId}, ${sessionStatus}, now(),
            ${JSON.stringify({ type: 'pipeline' })}::jsonb)
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, agent_session_id, device_id, created_by,
                      type, status, acked_at, payload)
    VALUES (${jobId}, ${projectId}, ${runId}, ${sessionId}, ${deviceId}, ${ownerId}, 'code',
            'running', now(), '{}'::jsonb)
  `);
  return { jobId, sessionId };
}

async function post(jobId: string, events: unknown[]): Promise<Response> {
  return app.request(`/api/jobs/${jobId}/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  });
}

type Row = {
  status: string;
  started_at: string | null;
  last_heartbeat_at: string | null;
  runtime_state: string | null;
};

async function session(id: string): Promise<Row> {
  const rows = await harness.db.execute<Row>(sql`
    SELECT status, started_at::text AS started_at, last_heartbeat_at::text AS last_heartbeat_at,
           runtime_state
    FROM agent_sessions WHERE id = ${id}
  `);
  const row = rows[0];
  if (!row) throw new Error('session vanished');
  return row;
}

/** Every `agent-session.status` publication, counted PER ROOM — `broadcastSessionEvent`
 *  publishes one to the project room and one to the device room for a single flip, so a
 *  global count of 1 would be wrong and a global count of 2 hides a duplicate to one room. */
function statusBroadcastsByRoom(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [room, payload] of publish.mock.calls) {
    if ((payload as { event?: string })?.event !== 'agent-session.status') continue;
    out[room as string] = (out[room as string] ?? 0) + 1;
  }
  return out;
}

/** The pane lane's own beat, verbatim: `daemon/pool_jobs.rs#CoreReport::progress`. */
const paneBeat = { kind: 'progress', data: { source: 'pool_jobs', state: 'running' } };
const starting = { kind: 'progress', data: { runtimeState: 'starting' } };
const working = { kind: 'progress', data: { runtimeState: 'working' } };
const closed = { kind: 'progress', data: { runtimeState: 'closed' } };
const park = { kind: 'progress', data: { runtimeState: 'awaiting_input' } };
const stdout = { kind: 'stdout', data: { line: { type: 'assistant' } } };

describe('ISS-1101 · a beat proves the box, a report proves the turn', () => {
  it('leaves a queued session queued for the pane lane beat, and stamps no started_at', async () => {
    const { jobId, sessionId } = await seed('queued');

    expect((await post(jobId, [paneBeat])).status).toBe(200);

    const after = await session(sessionId);
    expect(after.status).toBe('queued');
    expect(after.started_at).toBeNull();
  });

  it('refreshes last_heartbeat_at for that same beat', async () => {
    const { jobId, sessionId } = await seed('queued');
    expect(await session(sessionId).then((r) => r.last_heartbeat_at)).toBeNull();

    expect((await post(jobId, [paneBeat])).status).toBe(200);

    expect(await session(sessionId).then((r) => r.last_heartbeat_at)).not.toBeNull();
  });

  it('leaves a queued session queued for a beat that reports starting', async () => {
    const { jobId, sessionId } = await seed('queued');

    expect((await post(jobId, [starting])).status).toBe(200);

    expect(await session(sessionId).then((r) => r.status)).toBe('queued');
  });

  it('records starting on the row while leaving it queued, so the two facts are both readable', async () => {
    const { jobId, sessionId } = await seed('queued');

    expect((await post(jobId, [starting])).status).toBe(200);

    expect(await session(sessionId)).toMatchObject({ status: 'queued', runtime_state: 'starting' });
  });

  it('moves a queued session to running when a beat reports working, and stamps started_at', async () => {
    const { jobId, sessionId } = await seed('queued');

    expect((await post(jobId, [working])).status).toBe(200);

    const after = await session(sessionId);
    expect(after.status).toBe('running');
    expect(after.started_at).not.toBeNull();
  });

  it("moves a queued session to running on the agent's own output", async () => {
    const { jobId, sessionId } = await seed('queued');

    expect((await post(jobId, [stdout])).status).toBe(200);

    expect(await session(sessionId).then((r) => r.status)).toBe('running');
  });

  it('leaves a queued session queued for a beat that reports the session closed', async () => {
    const { jobId, sessionId } = await seed('queued');

    expect((await post(jobId, [closed])).status).toBe(200);

    expect(await session(sessionId).then((r) => r.status)).toBe('queued');
  });

  it('announces the flip exactly once per room when a batch reports a turn', async () => {
    const { jobId } = await seed('queued');

    expect((await post(jobId, [working])).status).toBe(200);

    expect(statusBroadcastsByRoom()).toEqual({
      [`project:${projectId}`]: 1,
      [`device:${deviceId}`]: 1,
    });
  });

  it('announces nothing for a batch that reported no turn', async () => {
    const { jobId } = await seed('queued');

    expect((await post(jobId, [paneBeat])).status).toBe(200);

    expect(statusBroadcastsByRoom()).toEqual({});
  });

  it('leaves a running session running when a later batch reports nothing about the agent', async () => {
    const { jobId, sessionId } = await seed('running');

    expect((await post(jobId, [paneBeat])).status).toBe(200);

    expect(await session(sessionId).then((r) => r.status)).toBe('running');
  });

  it('still costs exactly one agent_sessions statement, on either branch', async () => {
    await harness.db.execute(sql`
      CREATE TABLE IF NOT EXISTS iss1101_statements (table_name text NOT NULL)
    `);
    await harness.db.execute(sql`
      CREATE OR REPLACE FUNCTION iss1101_count_statement() RETURNS trigger AS $fn$
      BEGIN INSERT INTO iss1101_statements (table_name) VALUES (TG_TABLE_NAME); RETURN NULL; END
      $fn$ LANGUAGE plpgsql
    `);
    await harness.db.execute(sql`DROP TRIGGER IF EXISTS iss1101_stmt ON agent_sessions`);
    await harness.db.execute(sql`
      CREATE TRIGGER iss1101_stmt AFTER UPDATE ON agent_sessions
      FOR EACH STATEMENT EXECUTE FUNCTION iss1101_count_statement()
    `);
    const count = async () =>
      Number(
        (
          await harness.db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM iss1101_statements`)
        )[0]?.n ?? 0,
      );
    try {
      const bare = await seed('queued');
      await harness.db.execute(sql`DELETE FROM iss1101_statements`);
      expect((await post(bare.jobId, [paneBeat])).status).toBe(200);
      expect(await count()).toBe(1);

      const flipping = await seed('queued');
      await harness.db.execute(sql`DELETE FROM iss1101_statements`);
      expect((await post(flipping.jobId, [working])).status).toBe(200);
      // The heartbeat statement, plus the sibling `runtime_state` statement a batch
      // reporting a state has always written (ISS-1014's own guard says so).
      expect(await count()).toBe(2);
    } finally {
      await harness.db.execute(sql`DROP TRIGGER IF EXISTS iss1101_stmt ON agent_sessions`);
      await harness.db.execute(sql`DROP TABLE IF EXISTS iss1101_statements`);
    }
  });

  it('does not revive a terminal session', async () => {
    const { jobId, sessionId } = await seed('queued');
    await harness.db.execute(sql`
      UPDATE agent_sessions SET status = 'failed', failure_reason = 'queue_timeout' WHERE id = ${sessionId}
    `);

    expect((await post(jobId, [working])).status).toBe(200);

    expect(await session(sessionId).then((r) => r.status)).toBe('failed');
  });

  it('still writes no heartbeat for a park-only batch', async () => {
    const { jobId, sessionId } = await seed('queued');

    expect((await post(jobId, [park])).status).toBe(200);

    const after = await session(sessionId);
    expect(after.last_heartbeat_at).toBeNull();
    expect(after.runtime_state).toBe('awaiting_input');
  });
});
