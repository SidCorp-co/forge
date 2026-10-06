import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestDevice, createTestProject, createTestUser, rows } from '../helpers/factories.js';

// ADR 0009, What core takes over: Idle verdict. The box keeps no residency clock: core tells it to
// close a chat session that has waited past the residency, and stops telling once the box answers.

const MIN = 60_000;
let projectId = '';
let ownerId = '';
let deviceId = '';

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  deviceId = await createTestDevice(ownerId);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

async function chat(
  beatAgoMs: number,
  runtimeState: string,
  now: Date,
  status = 'completed',
  kind = 'chat',
): Promise<string> {
  const runId = randomUUID();
  const sessionId = randomUUID();
  const beat = new Date(now.getTime() - beatAgoMs).toISOString();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${runId}, ${projectId}, 'interactive', 'running')
  `);
  await db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, user_id, pipeline_run_id, kind, status, device_id, runtime_state, last_heartbeat_at, claude_session_id)
    VALUES (${sessionId}, ${projectId}, ${ownerId}, ${runId}, ${kind}, ${status}, ${deviceId}, ${runtimeState}, ${beat}::timestamptz, ${randomUUID()})
  `);
  return sessionId;
}

async function closesTold(sessionId: string): Promise<number> {
  const [row] = await rows<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM pipeline_outbox
     WHERE type = 'session.pushed'
       AND payload->>'event' = 'agent:close'
       AND payload->'data'->>'sessionId' = ${sessionId}
       AND payload->>'deviceId' = ${deviceId}
  `);
  return row?.n ?? 0;
}

async function runtimeOf(sessionId: string): Promise<string | null> {
  const [row] = await rows<{ s: string | null }>(
    sql`SELECT runtime_state AS s FROM agent_sessions WHERE id = ${sessionId}`,
  );
  return row?.s ?? null;
}

async function statusOf(sessionId: string): Promise<string | null> {
  const [row] = await rows<{ s: string | null }>(
    sql`SELECT status || coalesce('/' || failure_reason, '') AS s FROM agent_sessions WHERE id = ${sessionId}`,
  );
  return row?.s ?? null;
}

describe('closeIdleResidents: core takes the idle verdict on a resident chat session', () => {
  it('tells the box to close a session waiting past the residency, every pass until it answers', async () => {
    const { closeIdleResidents } = await import('../../src/jobs/park-deadline.js');
    const now = new Date();
    const idle = await chat(11 * MIN, 'awaiting_input', now);
    const fresh = await chat(9 * MIN, 'awaiting_input', now);
    const closed = await chat(30 * MIN, 'closed', now);
    await closeIdleResidents(now, { projectId });
    expect(await closesTold(idle)).toBe(1);
    expect(await closesTold(fresh)).toBe(0);
    expect(await closesTold(closed)).toBe(0);
    await closeIdleResidents(now, { projectId });
    expect(await closesTold(idle)).toBe(2);
    await db.execute(sql`UPDATE agent_sessions SET runtime_state = 'closed' WHERE id = ${idle}`);
    await closeIdleResidents(now, { projectId });
    expect(await closesTold(idle)).toBe(2);
  });

  it('reads a box silent for the hour after as gone, and ends the residency on the row', async () => {
    const { closeIdleResidents } = await import('../../src/jobs/park-deadline.js');
    const now = new Date();
    const lapsed = await chat(71 * MIN, 'awaiting_input', now);
    await closeIdleResidents(now, { projectId });
    expect(await closesTold(lapsed)).toBe(0);
    expect(await runtimeOf(lapsed)).toBe('closed');
  });
});

describe('one residency clock: a whole loop-monitor pass over a resident chat session', () => {
  it('leaves a chat parked 20 min, whose box has not answered agent:close, to the idle verdict', async () => {
    const { runLoopMonitor } = await import('../../src/jobs/loop-monitor.js');
    const now = new Date();
    const parked = await chat(20 * MIN, 'awaiting_input', now);
    await runLoopMonitor(now, { projectId });
    expect(await statusOf(parked)).toBe('completed');
    expect(await runtimeOf(parked)).toBe('awaiting_input');
    expect(await closesTold(parked)).toBe(1);
  });

  it('neither fails nor closes a chat whose next turn was dispatched 20 min ago and is still running', async () => {
    const { runLoopMonitor } = await import('../../src/jobs/loop-monitor.js');
    const now = new Date();
    // A turn moves the row to running and stamps its beat; the runtime state stays the one the box
    // reported at the end of the turn before, until this turn's own end is reported.
    const turn = await chat(20 * MIN, 'awaiting_input', now, 'running');
    await runLoopMonitor(now, { projectId });
    expect(await statusOf(turn)).toBe('running');
    expect(await closesTold(turn)).toBe(0);
  });

  it('still fails a job-linked park an older runner left 20 min past its last beat', async () => {
    const { runLoopMonitor } = await import('../../src/jobs/loop-monitor.js');
    const now = new Date();
    const park = await chat(20 * MIN, 'awaiting_input', now, 'running', 'pipeline');
    await runLoopMonitor(now, { projectId });
    expect(await statusOf(park)).toBe('failed/residency_expired');
    expect(await closesTold(park)).toBe(0);
  });
});
