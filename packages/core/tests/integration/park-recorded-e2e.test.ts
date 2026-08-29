/**
 * The park reaches the column its readers actually read — real Postgres.
 *
 * ISS-873 phases 1b–3 put three readers on `agent_sessions.runtime_state`: the
 * quiet-clock exemption, the residency deadline and the result guard. On the
 * PIPELINE path there was no writer — the runner keys a duplex session by
 * `job_id`, so the session-keyed PATCH that writes the column 404s, and the
 * park arrived only as a job event nobody stored. All three hops were inert on
 * the path they were built for, and no unit test could see it: the column was
 * simply never touched.
 *
 * So the assertions here are about the COLUMN after a real batch, and about
 * the two rules that separate this write from the heartbeat sync beside it.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
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
  vi.mock('../../src/ws/broadcast.js', () => ({
    broadcast: vi.fn(),
    broadcastToProject: vi.fn(),
  }));

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
  ownerId = (await createTestUser(harness.db)).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  const { issueDeviceToken } = await import('../../src/auth/deviceToken.js');
  const issued = await issueDeviceToken({ ownerId, name: 'd1', platform: 'linux' });
  deviceId = issued.device.id;
  deviceToken = issued.plaintext;
});

const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();

async function jobWithSession(sessionStatus = 'running'): Promise<{ job: string; sess: string }> {
  const jobId = randomUUID();
  const runId = randomUUID();
  const sessId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${projectId}, 'interactive', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, status, metadata,
                                last_heartbeat_at)
    VALUES (${sessId}, ${projectId}, ${runId}, ${deviceId}, ${sessionStatus},
            ${JSON.stringify({ type: 'pipeline' })}::jsonb, ${HOUR_AGO}::timestamptz)
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, agent_session_id, device_id, created_by,
                      type, status)
    VALUES (${jobId}, ${projectId}, ${runId}, ${sessId}, ${deviceId}, ${ownerId}, 'code', 'running')
  `);
  return { job: jobId, sess: sessId };
}

async function post(jobId: string, events: unknown[]): Promise<Response> {
  return app.request(`/api/jobs/${jobId}/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  });
}

const park = { kind: 'progress', data: { runtimeState: 'awaiting_input' } };
const working = { kind: 'progress', data: { runtimeState: 'working' } };
const beat = { kind: 'progress', data: { heartbeat: true } };

async function sessionRow(id: string) {
  const rows = await harness.db.execute<{
    runtime_state: string | null;
    last_heartbeat_at: string;
  }>(sql`SELECT runtime_state, last_heartbeat_at FROM agent_sessions WHERE id = ${id}`);
  return rows[0];
}

describe('the park as a job event', () => {
  it('records the state the runner reported', async () => {
    const { job, sess } = await jobWithSession();
    expect((await post(job, [park])).status).toBe(200);
    expect((await sessionRow(sess))?.runtime_state).toBe('awaiting_input');
  });

  // cm:guard the two rules must stay SEPARATE. A park-only batch records the park and must NOT count as activity — folding this write into the heartbeat branch beside it would make the park invisible in exactly the case it exists for, since that branch skips a park-only batch entirely.
  it('records a park without counting it as a heartbeat', async () => {
    const { job, sess } = await jobWithSession();
    const before = (await sessionRow(sess))?.last_heartbeat_at;
    await post(job, [park]);
    const after = await sessionRow(sess);
    expect(after?.runtime_state).toBe('awaiting_input');
    expect(new Date(String(after?.last_heartbeat_at)).getTime()).toBe(
      new Date(String(before)).getTime(),
    );
  });

  it('records a working state and bumps the heartbeat, because that batch is activity', async () => {
    const { job, sess } = await jobWithSession();
    const before = (await sessionRow(sess))?.last_heartbeat_at;
    await post(job, [working]);
    const after = await sessionRow(sess);
    expect(after?.runtime_state).toBe('working');
    expect(new Date(String(after?.last_heartbeat_at)).getTime()).toBeGreaterThan(
      new Date(String(before)).getTime(),
    );
  });

  it('takes the LAST state in a batch, not the first', async () => {
    const { job, sess } = await jobWithSession();
    await post(job, [park, beat, working]);
    expect((await sessionRow(sess))?.runtime_state).toBe('working');
  });

  it('leaves the column alone for a batch that reports no state', async () => {
    const { job, sess } = await jobWithSession();
    await post(job, [park]);
    await post(job, [beat, { kind: 'stdout', data: { line: 'hello' } }]);
    expect((await sessionRow(sess))?.runtime_state).toBe('awaiting_input');
  });

  // cm:guard the column is `text` with no database check, so an unrecognised string would PERSIST and then read as "not parked" to the exemption and "not a park" to the residency deadline — a session invisible to both hops with nothing to show for it.
  it('drops a state the enum does not know rather than writing it', async () => {
    const { job, sess } = await jobWithSession();
    await post(job, [park]);
    await post(job, [{ kind: 'progress', data: { runtimeState: 'napping' } }]);
    expect((await sessionRow(sess))?.runtime_state).toBe('awaiting_input');
  });

  // cm:guard never revive a session the kernel has already closed. The park deadline reaps to `failed`, and a late batch from the process it reaped would otherwise re-park a terminal row — which `resolveSessionSend` reads as "still reachable" and stops falling back on.
  it('refuses to park a session that has already reached a terminal status', async () => {
    const { job, sess } = await jobWithSession('failed');
    await post(job, [park]);
    expect((await sessionRow(sess))?.runtime_state).toBeNull();
  });
});
