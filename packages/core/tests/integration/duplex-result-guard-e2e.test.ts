/**
 * A resident session does not go immortal on its first turn — real Postgres.
 *
 * ISS-873 invariant 5. Both job-axis reapers skip a job that emitted a
 * `result`, which is exact under print (a `result` is the last thing the
 * process ever emits) and wrong under duplex (turn 1 emits one, and the job may
 * run for hours after it).
 *
 * The unit lane cannot fail on this: `loop-monitor.test.ts` mocks `db.execute`,
 * so the candidate SET is whatever the mock returns and the predicate under
 * test never runs. Both directions are asserted here — print must behave
 * EXACTLY as before, or the fix has bought duplex a reaper by taking one away
 * from every job still on the old path.
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
let monitor: typeof import('../../src/jobs/loop-monitor.js');

// cm:guard an ISO string, NOT a Date — postgres-js has no column type to bind a Date against inside a raw `sql` template and throws ERR_INVALID_ARG_TYPE, the same trap `loop-monitor.ts` records on its ackFast cutoff.
const STALE = new Date(Date.now() - 6 * 60 * 60_000).toISOString();

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
  monitor = await import('../../src/jobs/loop-monitor.js');
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

interface JobOpts {
  runtimeState?: string | null;
  sessionStatus?: string;
  withSession?: boolean;
  result?: boolean;
}

async function staleJob(opts: JobOpts): Promise<string> {
  const jobId = randomUUID();
  const runId = randomUUID();
  const actorId = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
    VALUES (${runId}, ${projectId}, 'interactive', 'running', ${STALE}::timestamptz)
  `);

  let sessionId: string | null = null;
  if (opts.withSession !== false) {
    sessionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions
        (id, project_id, pipeline_run_id, status, metadata, started_at, last_heartbeat_at,
         runtime_state, created_at, updated_at)
      VALUES (${sessionId}, ${projectId}, ${runId}, ${opts.sessionStatus ?? 'running'},
              ${JSON.stringify({ type: 'pipeline' })}::jsonb,
              ${STALE}::timestamptz, ${STALE}::timestamptz, ${opts.runtimeState ?? null},
              ${STALE}::timestamptz, ${STALE}::timestamptz)
    `);
  }

  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, agent_session_id, created_by,
                      type, status, dispatched_at, queued_at)
    VALUES (${jobId}, ${projectId}, ${runId}, ${sessionId}, ${actorId},
            'code', 'running', ${STALE}::timestamptz, ${STALE}::timestamptz)
  `);

  if (opts.result) {
    await harness.db.execute(sql`
      INSERT INTO job_events (id, job_id, kind, data, seq, ts)
      VALUES (${randomUUID()}, ${jobId}, 'result', '{}'::jsonb, 1, ${STALE}::timestamptz)
    `);
  }
  return jobId;
}

// cm:guard tick 1 of the two-phase kill gate returns `kill_requested`, never `reaped` — so `killRequested` is what says the row was a CANDIDATE. Asserting on `reaped` would read 0 for every case and the test would pass whatever the predicate selects.
async function resultHopPicked(): Promise<number> {
  return (await monitor.reapResultMisses(new Date(), { projectId })).killRequested;
}

describe('hop 4 · the result guard under residency', () => {
  it('still shields a print job that reported its result', async () => {
    await staleJob({ result: true });
    expect(await resultHopPicked()).toBe(0);
  });

  it('still reaps a print job that never reported one', async () => {
    await staleJob({ result: false });
    expect(await resultHopPicked()).toBe(1);
  });

  // cm:guard the whole of invariant 5. Before this predicate the `result` from turn 1 made the job permanently invisible to this hop, so a duplex session that wedged at hour three was never reaped by anything.
  it('reaps a resident session that has gone quiet since a turn ended', async () => {
    await staleJob({ result: true, runtimeState: 'working' });
    expect(await resultHopPicked()).toBe(1);
  });

  it('leaves a resident session parked on a human alone', async () => {
    await staleJob({ result: true, runtimeState: 'awaiting_input' });
    expect(await resultHopPicked()).toBe(0);
  });

  // cm:guard a park is exempt from the QUIET CLOCK only — with no result event it is still not reapable here, which is what keeps the exemption from being a second, wider amnesty than the one phase 2 priced.
  it('leaves a park alone whether or not a turn has ended yet', async () => {
    await staleJob({ result: false, runtimeState: 'awaiting_input' });
    expect(await resultHopPicked()).toBe(0);
  });

  it('reads a job with no session row at all as print', async () => {
    await staleJob({ result: true, withSession: false });
    expect(await resultHopPicked()).toBe(0);
  });

  it('separates print from resident in one sweep rather than exempting the batch', async () => {
    await staleJob({ result: true });
    await staleJob({ result: true, runtimeState: 'working' });
    expect(await resultHopPicked()).toBe(1);
  });
});

describe('hop 3c · session-lost under residency', () => {
  async function sessionLostPicked(): Promise<number> {
    return (await monitor.reapSessionLostJobs(new Date(), { projectId })).killRequested;
  }

  it('still shields a print job that reported its result', async () => {
    await staleJob({ result: true, sessionStatus: 'failed' });
    expect(await sessionLostPicked()).toBe(0);
  });

  // cm:guard no park exemption on THIS hop, deliberately: the session is already terminal, so the process is gone and there is nobody left to answer. Exempting a parked-and-dead session would wedge the runner slot with nothing on the other end of the question.
  it('reaps a resident job whose session died after a turn ended', async () => {
    await staleJob({ result: true, runtimeState: 'awaiting_input', sessionStatus: 'failed' });
    expect(await sessionLostPicked()).toBe(1);
  });

  it('still reaps a print job whose session died with no result', async () => {
    await staleJob({ result: false, sessionStatus: 'cancelled_stale' });
    expect(await sessionLostPicked()).toBe(1);
  });
});
