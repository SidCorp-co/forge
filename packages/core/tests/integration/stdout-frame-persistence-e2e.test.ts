/**
 * What the stdout filter actually leaves in the table, and what the startup
 * signal actually counts — real Postgres, because neither is reachable from a
 * unit test.
 *
 * Measured on forge-beta 2026-09-04: `job_events` held 7.29M `stdout` rows,
 * 99.79% of the table, and 74.8% of those carried `line.type = 'stream_event'`
 * — frames `lib/agent-stream-parser.ts` answers `{messages:[]}` for and no
 * other reader in core or web opens. They were stored forever and re-parsed on
 * every incremental transcript derive.
 *
 * The second half is the defect that filter would otherwise have moved in
 * silence: `deriveCcStartupSignals` counts what `pipeline/failure-classifier.ts`
 * reads as "≤3 assistant messages". It counted stdout ROWS, so
 * `--include-partial-messages` (ISS-479) had already broken it — one assistant
 * turn emits six to ten rows — and dropping stream_event rows would have moved
 * it a second time. Both halves are asserted against a real column here because
 * the unit suites mock the query away.
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

async function jobWithSession(): Promise<string> {
  const jobId = randomUUID();
  const runId = randomUUID();
  const sessId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${projectId}, 'interactive', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, status, metadata)
    VALUES (${sessId}, ${projectId}, ${runId}, ${deviceId}, 'running',
            ${JSON.stringify({ type: 'pipeline' })}::jsonb)
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, agent_session_id, device_id, created_by,
                      type, status)
    VALUES (${jobId}, ${projectId}, ${runId}, ${sessId}, ${deviceId}, ${ownerId}, 'code', 'running')
  `);
  return jobId;
}

async function post(jobId: string, events: unknown[]): Promise<Response> {
  return app.request(`/api/jobs/${jobId}/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  });
}

const stdoutLine = (line: unknown) => ({ kind: 'stdout', data: { line } });
const delta = stdoutLine({ type: 'stream_event', event: { type: 'content_block_delta' } });
const assistant = stdoutLine({ type: 'assistant', message: { model: 'claude-opus-5' } });

async function storedLineTypes(jobId: string): Promise<string[]> {
  const rows = await harness.db.execute<{ t: string | null }>(sql`
    SELECT data->'line'->>'type' AS t FROM job_events
    WHERE job_id = ${jobId} AND kind = 'stdout' ORDER BY seq
  `);
  return rows.map((r) => r.t ?? '<null>');
}

describe('stdout frames that reach the table', () => {
  it('keeps every frame a reader consumes and drops the stream_event ones', async () => {
    const job = await jobWithSession();
    const r = await post(job, [
      assistant,
      delta,
      delta,
      stdoutLine({ type: 'result', is_error: false }),
    ]);
    expect(r.status).toBe(200);
    expect(await storedLineTypes(job)).toEqual(['assistant', 'result']);
  });

  // cm:guard the denylist must pass an UNKNOWN frame through — turning it into an allowlist would stop storing the first frame kind a future CLI emits and report nothing, which is the silent substitution this filter exists to avoid becoming
  it('keeps a frame type it has never seen', async () => {
    const job = await jobWithSession();
    await post(job, [stdoutLine({ type: 'frame_invented_next_year' })]);
    expect(await storedLineTypes(job)).toEqual(['frame_invented_next_year']);
  });

  // cm:guard the regression this filter could cause — a fan-out session emits nothing but partial deltas for minutes, and if dropping them dropped the liveness signal too the loop monitor would reap a live agent, the exact failure `--include-partial-messages` was turned on to prevent (ISS-479); persistence and liveness are separate doors and must stay that way
  it('acks and bumps the session heartbeat for a batch that is entirely filtered out', async () => {
    const job = await jobWithSession();
    const r = await post(job, [delta, delta]);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ accepted: 0, firstSeq: null, lastSeq: null });
    expect(await storedLineTypes(job)).toEqual([]);

    const rows = await harness.db.execute<{ acked_at: string | null; beat: string | null }>(sql`
      SELECT j.acked_at, s.last_heartbeat_at AS beat
      FROM jobs j JOIN agent_sessions s ON s.id = j.agent_session_id
      WHERE j.id = ${job}
    `);
    expect(rows[0]?.acked_at).not.toBeNull();
    expect(rows[0]?.beat).not.toBeNull();
  });
});

describe('the cc-startup signal counts assistant turns', () => {
  // cm:guard the batch MUST carry persisted non-assistant stdout rows (system/user/result) or this test cannot fail — deltas are dropped before they reach the table, so a batch of only assistants and deltas counts the same under both the old `stdout` predicate and the assistant one, and the planted regression passes
  // cm:guard drives the REAL `deriveCcStartupSignals`, not a copy of its SQL — the predicate reaches into jsonb through a drizzle column reference inside a raw `sql` template, and a template that fails to render is swallowed by that function's catch, which logs and returns null; reimplementing the query here would assert Postgres works and prove nothing about the caller
  it('counts assistant lines, not stdout rows', async () => {
    const job = await jobWithSession();
    await post(job, [
      stdoutLine({ type: 'system', subtype: 'init' }),
      assistant,
      stdoutLine({ type: 'user' }),
      assistant,
      stdoutLine({ type: 'result', is_error: true }),
      delta,
    ]);
    const { deriveCcStartupSignals } = await import('../../src/jobs/retry.js');
    const signals = await deriveCcStartupSignals({ id: job } as never);
    expect(signals).not.toBeNull();
    expect(signals?.sessionMessageCount).toBe(2);
    expect(signals?.diedBeforeFirstToolUse).toBe(true);
  });
});
