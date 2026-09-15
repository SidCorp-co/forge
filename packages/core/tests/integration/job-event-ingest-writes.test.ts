/**
 * ISS-1014 — what the hot ingest path READS and how many statements it WRITES,
 * against a real Postgres, because neither is reachable from a unit test: the
 * suites that cover this route mock the drizzle chain away, so a projection that
 * still pulls `user_prompt_snapshot` and a CAS that still misses on every batch
 * both pass there.
 *
 * The instrument for "which columns does this read" is a RENAME: the five wide
 * `jobs` columns are renamed out from under the query, so a read that still
 * names one fails with `column ... does not exist` instead of quietly working.
 * The first test plants exactly that failure on `readJob` and watches it go red,
 * which is what makes the same rename standing green over `readJobGate` mean
 * anything.
 *
 * The instrument for "how many statements" is a FOR EACH STATEMENT trigger,
 * which fires once per UPDATE whether or not the statement matched a row — so a
 * CAS that misses is still counted, which is the whole point.
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

/** The five columns `readJobGate` exists to leave behind. */
const WIDE_COLUMNS = [
  'payload',
  'prompt_blocks',
  'failure_meta',
  'user_prompt_snapshot',
  'skills_ran_with',
] as const;

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let deviceId: string;
let deviceToken: string;
let app: Hono<{ Variables: Vars }>;
let userAuth: string;
let queries: typeof import('../../src/jobs/job-queries.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';

  queries = await import('../../src/jobs/job-queries.js');
  const { jobEventsRoutes, jobEventsListRoutes } = await import('../../src/jobs/events-routes.js');
  const { jobLifecycleDeviceRoutes } = await import('../../src/jobs/lifecycle-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: Vars }>();
  app.use('*', requestId());
  app.route('/api/jobs', jobEventsRoutes as never);
  app.route('/api/jobs', jobEventsListRoutes as never);
  app.route('/api/jobs', jobLifecycleDeviceRoutes as never);
  app.onError(errorHandler);

  await harness.db.execute(sql`
    CREATE TABLE IF NOT EXISTS iss1014_statements (table_name text NOT NULL, at timestamptz NOT NULL DEFAULT now())
  `);
  await harness.db.execute(sql`
    CREATE OR REPLACE FUNCTION iss1014_count_statement() RETURNS trigger AS $fn$
    BEGIN
      INSERT INTO iss1014_statements (table_name) VALUES (TG_TABLE_NAME);
      RETURN NULL;
    END $fn$ LANGUAGE plpgsql
  `);
  await harness.db.execute(sql`DROP TRIGGER IF EXISTS iss1014_sessions_stmt ON agent_sessions`);
  await harness.db.execute(sql`
    CREATE TRIGGER iss1014_sessions_stmt AFTER UPDATE ON agent_sessions
    FOR EACH STATEMENT EXECUTE FUNCTION iss1014_count_statement()
  `);
  await harness.db.execute(sql`DROP TRIGGER IF EXISTS iss1014_jobs_stmt ON jobs`);
  await harness.db.execute(sql`
    CREATE TRIGGER iss1014_jobs_stmt AFTER UPDATE ON jobs
    FOR EACH STATEMENT EXECUTE FUNCTION iss1014_count_statement()
  `);
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
  const { signUserToken } = await import('../../src/auth/jwt.js');
  userAuth = `Bearer ${await signUserToken(ownerId)}`;
});

interface Fixture {
  jobId: string;
  sessionId: string;
}

async function seed(
  sessionStatus: string,
  opts: { ackedAt?: string | null; startedAt?: string | null } = {},
): Promise<Fixture> {
  const jobId = randomUUID();
  const runId = randomUUID();
  const sessionId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${projectId}, 'interactive', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, status, started_at, metadata)
    VALUES (${sessionId}, ${projectId}, ${runId}, ${deviceId}, ${sessionStatus},
            ${opts.startedAt ?? null}::timestamptz, ${JSON.stringify({ type: 'pipeline' })}::jsonb)
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, agent_session_id, device_id, created_by,
                      type, status, acked_at, payload, user_prompt_snapshot)
    VALUES (${jobId}, ${projectId}, ${runId}, ${sessionId}, ${deviceId}, ${ownerId}, 'code',
            'running', ${opts.ackedAt ?? null}::timestamptz,
            ${JSON.stringify({ prompt: 'x'.repeat(2000) })}::jsonb, ${'y'.repeat(2000)})
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

async function statements(table: string): Promise<number> {
  const rows = await harness.db.execute<{ n: string }>(
    sql`SELECT count(*) AS n FROM iss1014_statements WHERE table_name = ${table}`,
  );
  return Number(rows[0]?.n ?? 0);
}

async function clearStatements(): Promise<void> {
  await harness.db.execute(sql`DELETE FROM iss1014_statements`);
}

type SessionRead = {
  status: string;
  started_at: string | null;
  last_heartbeat_at: string | null;
  runtime_state: string | null;
  updated_at: string;
};

// cm:why every timestamp comes back as `text`: `db.execute` on a raw template hands the driver's own representation through, which is a string here and a Date elsewhere — reading it as one or the other is how an assertion starts depending on the driver rather than on the row.
async function session(id: string): Promise<SessionRead> {
  const rows = await harness.db.execute<SessionRead>(sql`
    SELECT status,
           started_at::text AS started_at,
           last_heartbeat_at::text AS last_heartbeat_at,
           runtime_state,
           updated_at::text AS updated_at
    FROM agent_sessions WHERE id = ${id}
  `);
  const row = rows[0];
  if (!row) throw new Error('session vanished');
  return row;
}

const at = (value: string | null): string | null => (value ? new Date(value).toISOString() : null);

async function withWideColumnsHidden<T>(fn: () => Promise<T>): Promise<T> {
  for (const column of WIDE_COLUMNS) {
    await harness.db.execute(
      sql.raw(`ALTER TABLE jobs RENAME COLUMN "${column}" TO "${column}__iss1014_hidden"`),
    );
  }
  try {
    return await fn();
  } finally {
    for (const column of WIDE_COLUMNS) {
      await harness.db.execute(
        sql.raw(`ALTER TABLE jobs RENAME COLUMN "${column}__iss1014_hidden" TO "${column}"`),
      );
    }
  }
}

const stdout = { kind: 'stdout', data: { line: { type: 'assistant' } } };
const park = { kind: 'progress', data: { runtimeState: 'awaiting_input' } };
const working = { kind: 'progress', data: { runtimeState: 'working' } };

describe('ISS-1014 · the gate reads only the columns it uses', () => {
  it('answers with the wide columns renamed away, where readJob goes red on the same rename', async () => {
    const { jobId } = await seed('running');

    await withWideColumnsHidden(async () => {
      // cm:guard the PLANTED failure: without this line going red, the green below says nothing.
      await expect(queries.readJob(jobId)).rejects.toThrow(/user_prompt_snapshot|does not exist/);
      const gate = await queries.readJobGate(jobId);
      expect(gate).toMatchObject({ id: jobId, projectId, deviceId, status: 'running' });
      expect(Object.keys(gate ?? {}).sort()).toEqual([
        'ackedAt',
        'agentSessionId',
        'deviceId',
        'error',
        'id',
        'killRequestedAt',
        'projectId',
        'status',
      ]);
    });
  });

  it('ingests a batch and lists it back with the wide columns renamed away', async () => {
    const { jobId } = await seed('running');

    await withWideColumnsHidden(async () => {
      const posted = await post(jobId, [stdout]);
      expect(posted.status).toBe(200);
      expect(await posted.json()).toMatchObject({ accepted: 1 });

      const listed = await app.request(`/api/jobs/${jobId}/events`, {
        headers: { authorization: userAuth },
      });
      expect(listed.status).toBe(200);
      const body = (await listed.json()) as { items: Array<{ kind: string }>; lastSeq: number };
      expect(body.items.map((i) => i.kind)).toEqual(['stdout']);
      expect(body.lastSeq).toBe(1);
    });
  });
});

describe('ISS-1014 · the lifecycle gates read through the same door', () => {
  // cm:why only these two of the six: `/complete`, `/fail`, `/cancel` and `/resume` go on to read a WHOLE job row from `applyKernelTransition` and from `cancelJob`, which is outside this issue and fails under the rename for that reason rather than for the gate's. What they share with these two is `loadJob`, the one door, and that door is the subject of the first test in this file.
  it('acks and kill-acks with the wide columns renamed away', async () => {
    const { jobId } = await seed('running', { ackedAt: null });

    await withWideColumnsHidden(async () => {
      const acked = await app.request(`/api/jobs/${jobId}/ack`, {
        method: 'POST',
        headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(acked.status).toBe(200);
      expect(await acked.json()).toMatchObject({ jobId, acked: true });

      await harness.db.execute(sql`UPDATE jobs SET kill_requested_at = now() WHERE id = ${jobId}`);
      const killed = await app.request(`/api/jobs/${jobId}/kill-ack`, {
        method: 'POST',
        headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ outcome: 'killed' }),
      });
      expect(killed.status).toBe(200);
      expect(await killed.json()).toMatchObject({ jobId, recorded: true, killOutcome: 'killed' });
    });
  });
});

describe('ISS-1014 · one batch, one heartbeat statement', () => {
  it('flips a queued session to running in ONE statement and broadcasts once', async () => {
    const { jobId, sessionId } = await seed('queued');
    await clearStatements();

    expect((await post(jobId, [stdout])).status).toBe(200);

    expect(await statements('agent_sessions')).toBe(1);
    const after = await session(sessionId);
    expect(after.status).toBe('running');
    expect(after.started_at).not.toBeNull();
    expect(after.last_heartbeat_at).not.toBeNull();
    const statusPublishes = publish.mock.calls.filter(
      (c) => (c[1] as { event?: string } | undefined)?.event === 'agent-session.status',
    );
    expect(statusPublishes).toHaveLength(2);
  });

  it('bumps an already-running session in ONE statement and broadcasts no status', async () => {
    const startedAt = '2026-09-01T00:00:00.000Z';
    const { jobId, sessionId } = await seed('running', { startedAt });
    await clearStatements();
    publish.mockClear();

    expect((await post(jobId, [stdout])).status).toBe(200);

    expect(await statements('agent_sessions')).toBe(1);
    const after = await session(sessionId);
    expect(after.status).toBe('running');
    // cm:why the CASE stamps `started_at` only on the flip, so an already-running row keeps its own.
    expect(at(after.started_at)).toBe(startedAt);
    expect(after.last_heartbeat_at).not.toBeNull();
    expect(
      publish.mock.calls.filter(
        (c) => (c[1] as { event?: string } | undefined)?.event === 'agent-session.status',
      ),
    ).toHaveLength(0);
  });

  it('leaves a running session with a NULL started_at exactly as it found it', async () => {
    const { jobId, sessionId } = await seed('running', { startedAt: null });
    expect((await post(jobId, [stdout])).status).toBe(200);
    const after = await session(sessionId);
    expect(after.started_at).toBeNull();
    expect(after.last_heartbeat_at).not.toBeNull();
  });

  it('writes nothing to a session that already reached a terminal status', async () => {
    const { jobId, sessionId } = await seed('completed');
    const before = await session(sessionId);

    expect((await post(jobId, [stdout])).status).toBe(200);

    const after = await session(sessionId);
    expect(after.status).toBe('completed');
    expect(after.last_heartbeat_at).toBeNull();
    expect(at(after.updated_at)).toBe(at(before.updated_at));
  });

  it('records a park without bumping the heartbeat', async () => {
    const { jobId, sessionId } = await seed('running');
    await clearStatements();

    expect((await post(jobId, [park])).status).toBe(200);

    const after = await session(sessionId);
    expect(after.runtime_state).toBe('awaiting_input');
    expect(after.last_heartbeat_at).toBeNull();
    // cm:why 1 is the runtime-state write alone — the heartbeat statement is not issued for a park.
    expect(await statements('agent_sessions')).toBe(1);
  });

  it('writes agent_sessions twice for a batch that is both activity and a reported state', async () => {
    const { jobId, sessionId } = await seed('running');
    await clearStatements();

    expect((await post(jobId, [stdout, working])).status).toBe(200);

    expect(await statements('agent_sessions')).toBe(2);
    const after = await session(sessionId);
    expect(after.runtime_state).toBe('working');
    expect(after.last_heartbeat_at).not.toBeNull();
  });
});

describe('ISS-1014 · the ack stamp is gated on the row already read', () => {
  it('stamps acked_at and clears the kill columns on the first batch', async () => {
    const { jobId } = await seed('running', { ackedAt: null });
    await harness.db.execute(sql`
      UPDATE jobs SET kill_requested_at = now(), kill_confirmed_at = now(), kill_outcome = 'killed'
      WHERE id = ${jobId}
    `);
    await clearStatements();

    expect((await post(jobId, [stdout])).status).toBe(200);

    expect(await statements('jobs')).toBe(1);
    const rows = await harness.db.execute<{
      acked_at: Date | null;
      kill_requested_at: Date | null;
      kill_confirmed_at: Date | null;
      kill_outcome: string | null;
    }>(sql`
      SELECT acked_at, kill_requested_at, kill_confirmed_at, kill_outcome FROM jobs WHERE id = ${jobId}
    `);
    expect(rows[0]?.acked_at).not.toBeNull();
    expect(rows[0]?.kill_requested_at).toBeNull();
    expect(rows[0]?.kill_confirmed_at).toBeNull();
    expect(rows[0]?.kill_outcome).toBeNull();
  });

  it('issues no jobs UPDATE at all once acked_at is stamped', async () => {
    const { jobId } = await seed('running', { ackedAt: '2026-09-01T00:00:00.000Z' });
    await clearStatements();

    expect((await post(jobId, [stdout])).status).toBe(200);

    expect(await statements('jobs')).toBe(0);
  });
});
