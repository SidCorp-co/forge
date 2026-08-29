/**
 * A park outlives its runner — real Postgres.
 *
 * ISS-873 phase 3. Phase 2 exempted `awaiting_input` from the heartbeat hop and
 * left the park bounded by one thing: the runner's own idle ceiling. This hop
 * is the backstop for when that runner is gone, so it must fire LATE (residency
 * plus a grace) and never on a park the runner still owns.
 *
 * The predicate reads `sessionResidencySeconds` out of `agent_config ->
 * 'pipelineConfig'`, and a wrong JSON path there does not fail — COALESCE
 * swallows it and every project silently falls back to the default. The
 * configured-residency case below is the only assertion that can go red on it.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let projectId: string;
let reapExpiredParks: typeof import('../../src/jobs/park-deadline.js').reapExpiredParks;
let reapSessionLostJobs: typeof import('../../src/jobs/loop-monitor.js').reapSessionLostJobs;

const MINUTES = 60_000;
// cm:guard ISO strings, never Date objects — postgres-js has no column type to bind a Date against inside a raw `sql` template and throws ERR_INVALID_ARG_TYPE.
const ago = (m: number): string => new Date(Date.now() - m * MINUTES).toISOString();

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
  ({ reapExpiredParks } = await import('../../src/jobs/park-deadline.js'));
  ({ reapSessionLostJobs } = await import('../../src/jobs/loop-monitor.js'));
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const ownerId = (await createTestUser(harness.db)).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
});

async function setResidency(seconds: number): Promise<void> {
  await harness.db.execute(sql`
    UPDATE projects
       SET agent_config = ${JSON.stringify({ pipelineConfig: { sessionResidencySeconds: seconds } })}::jsonb
     WHERE id = ${projectId}
  `);
}

async function session(opts: {
  quietMinutes: number;
  runtimeState?: string | null;
  withJob?: boolean;
}): Promise<string> {
  const id = randomUUID();
  const runId = randomUUID();
  const at = ago(opts.quietMinutes);
  // cm:guard `in`, not `??` — an explicit `runtimeState: null` is the print-mode case, and `??` collapses it back to the park, which turns that test into a second copy of the one above it.
  const state = 'runtimeState' in opts ? opts.runtimeState : 'awaiting_input';
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
    VALUES (${runId}, ${projectId}, 'interactive', 'running', ${at}::timestamptz)
  `);
  await harness.db.execute(sql`
    INSERT INTO agent_sessions
      (id, project_id, pipeline_run_id, status, metadata, started_at, last_heartbeat_at,
       runtime_state, created_at, updated_at)
    VALUES (${id}, ${projectId}, ${runId}, 'running',
            ${JSON.stringify({ type: 'pipeline' })}::jsonb,
            ${at}::timestamptz, ${at}::timestamptz, ${state},
            ${at}::timestamptz, ${at}::timestamptz)
  `);
  if (opts.withJob) {
    const actorId = (await createTestUser(harness.db)).id;
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, agent_session_id, created_by,
                        type, status, dispatched_at, queued_at)
      VALUES (${randomUUID()}, ${projectId}, ${runId}, ${id}, ${actorId},
              'code', 'running', ${at}::timestamptz, ${at}::timestamptz)
    `);
  }
  return id;
}

async function jobKillOpened(): Promise<boolean> {
  const rows = await harness.db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM jobs
     WHERE project_id = ${projectId} AND kill_requested_at IS NOT NULL
  `);
  return (rows[0]?.n ?? 0) > 0;
}

async function stateOf(id: string): Promise<{ status: string; reason: string | null }> {
  const rows = await harness.db.execute<{ status: string; failure_reason: string | null }>(sql`
    SELECT status, failure_reason FROM agent_sessions WHERE id = ${id}
  `);
  const r = rows[0];
  return { status: r?.status ?? 'gone', reason: r?.failure_reason ?? null };
}

async function sweep(): Promise<number> {
  return reapExpiredParks(new Date(), { projectId });
}

describe('the residency deadline', () => {
  // cm:guard the default is 10min residency + 5min grace = 15. A park at 10 minutes is one the runner is still holding, and reaping it here would make core and the runner race to close the same session.
  it('leaves a park the runner still owns alone', async () => {
    const id = await session({ quietMinutes: 10 });
    expect(await sweep()).toBe(0);
    expect((await stateOf(id)).status).toBe('running');
  });

  it('closes a park that outlived the runner ceiling and its grace', async () => {
    const id = await session({ quietMinutes: 20 });
    expect(await sweep()).toBe(1);
    expect(await stateOf(id)).toEqual({ status: 'failed', reason: 'residency_expired' });
  });

  // cm:guard the ONLY assertion that can fail on a mistyped JSON path — every other case reads the default, which COALESCE supplies whether the path resolves or not. Deleting this test does not weaken the suite, it blinds it.
  it('honours a residency the project actually configured', async () => {
    await setResidency(3600);
    const id = await session({ quietMinutes: 30 });
    expect(await sweep()).toBe(0);
    expect((await stateOf(id)).status).toBe('running');
  });

  it('closes sooner when the project configured a shorter residency', async () => {
    await setResidency(60);
    const id = await session({ quietMinutes: 10 });
    expect(await sweep()).toBe(1);
    expect(await stateOf(id)).toEqual({ status: 'failed', reason: 'residency_expired' });
  });

  // cm:guard this hop owns the park and NOTHING else — a working session that has gone quiet belongs to the heartbeat hop, and reaping it here would give it a reason that sends whoever reads it to the wrong logs.
  it('does not touch a session that is working, however quiet', async () => {
    const id = await session({ quietMinutes: 120, runtimeState: 'working' });
    expect(await sweep()).toBe(0);
    expect((await stateOf(id)).status).toBe('running');
  });

  it('does not touch a print-mode session that reports no state', async () => {
    await session({ quietMinutes: 120, runtimeState: null });
    expect(await sweep()).toBe(0);
  });

  // cm:guard the point of the hop is CAPACITY, not a tidier row. Closing the session while its job stays `running` leaks the runner slot exactly as before at RUNNER_CAP_PER_RUNNER = 1 — this pair is the only assertion that the park hop buys anything.
  it('lets the session-lost hop open a kill on the job it was holding', async () => {
    await session({ quietMinutes: 20, withJob: true });
    expect(await jobKillOpened()).toBe(false);
    await sweep();
    await reapSessionLostJobs(new Date(), { projectId });
    expect(await jobKillOpened()).toBe(true);
  });

  it('leaves that job alone while the park is still live', async () => {
    await session({ quietMinutes: 2, withJob: true });
    await sweep();
    await reapSessionLostJobs(new Date(), { projectId });
    expect(await jobKillOpened()).toBe(false);
  });

  it('separates an expired park from a live one in the same sweep', async () => {
    const expired = await session({ quietMinutes: 20 });
    const live = await session({ quietMinutes: 2 });
    expect(await sweep()).toBe(1);
    expect((await stateOf(expired)).status).toBe('failed');
    expect((await stateOf(live)).status).toBe('running');
  });
});
