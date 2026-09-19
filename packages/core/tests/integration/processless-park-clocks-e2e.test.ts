/**
 * Two clocks over one row, and the fact that separates them — real Postgres.
 *
 * A park that RELEASES its process is bounded by the asker's own deadline, not
 * by residency: residency fires on the presumption that the runner failed to
 * honour its ceiling, and a park with no process falsifies that premise by
 * design. So `reapExpiredParks` exempts it and `reapUnansweredParks` bounds it
 * instead — one clock per premise, and no state under none (ISS-964 criteria
 * 24, 34).
 *
 * The fact is `blocker_kind`, and the machine case below is why it cannot be
 * "an open question exists": `begin_question` is step one of BOTH arms of
 * `runner/blocked.rs`, so a machine park writes an open row too and that park
 * still holds its process.
 *
 * Real Postgres because every claim is which rows a correlated `NOT EXISTS`
 * keeps, and a mocked query chain answers from whatever the mock was handed.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ws/broadcast.js', () => ({
  broadcast: vi.fn(),
  broadcastToProject: vi.fn(),
}));

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
let reapUnansweredParks: typeof import('../../src/jobs/park-deadline.js').reapUnansweredParks;
let reapSessionLostJobs: typeof import('../../src/jobs/loop-monitor.js').reapSessionLostJobs;
let reapOrphanedOneShotRuns: typeof import('../../src/pipeline/sweeper.js').reapOrphanedOneShotRuns;

const MINUTES = 60_000;
const ago = (m: number): string => new Date(Date.now() - m * MINUTES).toISOString();
const ahead = (m: number): string => new Date(Date.now() + m * MINUTES).toISOString();

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  ({ reapExpiredParks, reapUnansweredParks } = await import('../../src/jobs/park-deadline.js'));
  ({ reapSessionLostJobs } = await import('../../src/jobs/loop-monitor.js'));
  ({ reapOrphanedOneShotRuns } = await import('../../src/pipeline/sweeper.js'));
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

/** A session parked `quietMinutes` ago, with no question row of its own. */
async function parkedSession(quietMinutes: number): Promise<string> {
  const id = randomUUID();
  const runId = randomUUID();
  const at = ago(quietMinutes);
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
            ${at}::timestamptz, ${at}::timestamptz, 'awaiting_input',
            ${at}::timestamptz, ${at}::timestamptz)
  `);
  return id;
}

async function question(
  sessionId: string,
  opts: {
    blockerKind: 'human' | 'machine' | 'master_or_peer';
    status?: 'open' | 'answered' | 'void';
    deadline?: string | null;
    askedMinutesAgo?: number;
  },
): Promise<string> {
  const id = randomUUID();
  const at = ago(opts.askedMinutesAgo ?? 0);
  await harness.db.execute(sql`
    INSERT INTO agent_questions
      (id, project_id, agent_session_id, status, blocker_kind, steps, park_deadline_at,
       created_at, updated_at)
    VALUES (${id}, ${projectId}, ${sessionId}, ${opts.status ?? 'open'}, ${opts.blockerKind},
            '[]'::jsonb, ${opts.deadline ?? null}::timestamptz, ${at}::timestamptz,
            ${at}::timestamptz)
  `);
  return id;
}

async function sessionState(id: string): Promise<{ status: string; reason: string | null }> {
  const rows = await harness.db.execute<{ status: string; failure_reason: string | null }>(sql`
    SELECT status, failure_reason FROM agent_sessions WHERE id = ${id}
  `);
  const r = rows[0];
  return { status: r?.status ?? 'gone', reason: r?.failure_reason ?? null };
}

async function questionState(
  id: string,
): Promise<{ status: string; endedReason: string | null; endedBy: string | null }> {
  const rows = await harness.db.execute<{
    status: string;
    ended_reason: string | null;
    ended_by: string | null;
  }>(sql`SELECT status, ended_reason, ended_by FROM agent_questions WHERE id = ${id}`);
  const r = rows[0];
  return {
    status: r?.status ?? 'gone',
    endedReason: r?.ended_reason ?? null,
    endedBy: r?.ended_by ?? null,
  };
}

const residencySweep = (): Promise<number> => reapExpiredParks(new Date(), { projectId });
const deadlineSweep = (): Promise<number> => reapUnansweredParks(new Date(), { projectId });

describe('residency does not bound a park that released its process', () => {
  it('leaves a human park alone however long it waits', async () => {
    const id = await parkedSession(20);
    await question(id, { blockerKind: 'human' });

    expect(await residencySweep()).toBe(0);
    expect((await sessionState(id)).status).toBe('running');
  });

  it('still reaps a machine park, whose process is held rather than released', async () => {
    const id = await parkedSession(20);
    await question(id, { blockerKind: 'machine' });

    expect(await residencySweep()).toBe(1);
    expect(await sessionState(id)).toEqual({ status: 'failed', reason: 'residency_expired' });
  });

  it('still reaps a master-or-peer park for the same reason', async () => {
    const id = await parkedSession(20);
    await question(id, { blockerKind: 'master_or_peer' });

    expect(await residencySweep()).toBe(1);
    expect((await sessionState(id)).reason).toBe('residency_expired');
  });

  it('still reaps a park that predates the question table', async () => {
    const id = await parkedSession(20);

    expect(await residencySweep()).toBe(1);
    expect(await sessionState(id)).toEqual({ status: 'failed', reason: 'residency_expired' });
  });

  it('reaps a human park again once the question is answered', async () => {
    const id = await parkedSession(20);
    await question(id, { blockerKind: 'human', status: 'answered' });

    expect(await residencySweep()).toBe(1);
    expect((await sessionState(id)).reason).toBe('residency_expired');
  });

  it('reaps a human park whose question was voided', async () => {
    const id = await parkedSession(20);
    await question(id, { blockerKind: 'human', status: 'void' });

    expect(await residencySweep()).toBe(1);
  });
});

describe('the asker deadline is what bounds a processless park', () => {
  it('never closes a park the asker set no deadline on', async () => {
    const id = await parkedSession(20);
    const q = await question(id, { blockerKind: 'human', deadline: null });

    expect(await deadlineSweep()).toBe(0);
    expect((await sessionState(id)).status).toBe('running');
    expect((await questionState(q)).status).toBe('open');
  });

  it('leaves a park whose deadline has not arrived', async () => {
    const id = await parkedSession(20);
    const q = await question(id, { blockerKind: 'human', deadline: ahead(60) });

    expect(await deadlineSweep()).toBe(0);
    expect((await questionState(q)).status).toBe('open');
  });

  it('closes an expired park loudly, naming the days it waited', async () => {
    const id = await parkedSession(60 * 24 * 3);
    const q = await question(id, {
      blockerKind: 'human',
      deadline: ago(30),
      askedMinutesAgo: 60 * 24 * 2,
    });

    expect(await deadlineSweep()).toBe(1);
    expect(await sessionState(id)).toEqual({ status: 'failed', reason: 'park_unanswered' });
    expect(await questionState(q)).toEqual({
      status: 'expired',
      endedReason: 'unanswered_2d',
      endedBy: 'sweeper',
    });
  });

  it('floors the named duration at one day', async () => {
    const id = await parkedSession(300);
    const q = await question(id, {
      blockerKind: 'human',
      deadline: ago(10),
      askedMinutesAgo: 200,
    });

    expect(await deadlineSweep()).toBe(1);
    expect((await questionState(q)).endedReason).toBe('unanswered_1d');
  });

  it('closes one park once', async () => {
    const id = await parkedSession(60 * 24);
    await question(id, { blockerKind: 'human', deadline: ago(30), askedMinutesAgo: 60 * 24 });

    expect(await deadlineSweep()).toBe(1);
    expect(await deadlineSweep()).toBe(0);
  });

  it('ignores a machine park that carries a deadline', async () => {
    const id = await parkedSession(60 * 24);
    await question(id, { blockerKind: 'machine', deadline: ago(30), askedMinutesAgo: 60 * 24 });

    expect(await deadlineSweep()).toBe(0);
  });
});

/**
 * Closing the record must free the resource, and with the right cause.
 *
 * `reapUnansweredParks` fails the session; the session-lost hop is what frees
 * the job under it. That hop wrote one cause for every way a session can die,
 * and `infra` derives `retry` — so before this, closing a park dispatched a
 * fresh agent onto an issue whose question nobody had answered, which is
 * criterion 26's failure reached through the other door.
 */
describe('the job a closed park was holding', () => {
  async function jobUnder(sessionId: string): Promise<string> {
    const id = randomUUID();
    const actorId = (await createTestUser(harness.db)).id;
    const [run] = await harness.db.execute<{ pipeline_run_id: string }>(
      sql`SELECT pipeline_run_id FROM agent_sessions WHERE id = ${sessionId}`,
    );
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, agent_session_id, created_by,
                        type, status, dispatched_at, queued_at)
      VALUES (${id}, ${projectId}, ${run?.pipeline_run_id}, ${sessionId}, ${actorId},
              'code', 'running', ${ago(60)}::timestamptz, ${ago(60)}::timestamptz)
    `);
    return id;
  }

  async function runnerConfirmedTheKill(jobId: string): Promise<void> {
    await harness.db.execute(sql`
      UPDATE jobs SET kill_requested_at = now() - interval '120 seconds',
                      kill_confirmed_at = now() - interval '110 seconds',
                      kill_outcome = 'killed'
       WHERE id = ${jobId}
    `);
  }

  async function jobState(
    id: string,
  ): Promise<{ status: string; error: string | null; kind: string | null; action: string | null }> {
    const rows = await harness.db.execute<{
      status: string;
      error: string | null;
      failure_kind: string | null;
      failure_action: string | null;
    }>(sql`SELECT status, error, failure_kind, failure_action FROM jobs WHERE id = ${id}`);
    const r = rows[0];
    return {
      status: r?.status ?? 'gone',
      error: r?.error ?? null,
      kind: r?.failure_kind ?? null,
      action: r?.failure_action ?? null,
    };
  }

  async function retriesOf(id: string): Promise<number> {
    const rows = await harness.db.execute<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM jobs WHERE retry_of = ${id}`,
    );
    return rows[0]?.n ?? 0;
  }

  async function expiredPark(): Promise<string> {
    const sid = await parkedSession(60 * 24);
    await question(sid, { blockerKind: 'human', deadline: ago(30), askedMinutesAgo: 60 * 24 });
    return sid;
  }

  it('is failed once the clock closes the park', async () => {
    const sid = await expiredPark();
    const job = await jobUnder(sid);

    expect(await deadlineSweep()).toBe(1);
    await runnerConfirmedTheKill(job);
    await reapSessionLostJobs(new Date(), { projectId });

    expect((await jobState(job)).status).toBe('failed');
  });

  it('is not retried, because the question is still unanswered', async () => {
    const sid = await expiredPark();
    const job = await jobUnder(sid);

    expect(await deadlineSweep()).toBe(1);
    await runnerConfirmedTheKill(job);
    await reapSessionLostJobs(new Date(), { projectId });

    expect(await retriesOf(job)).toBe(0);
    expect(await jobState(job)).toMatchObject({ error: 'park_unanswered', kind: 'code' });
  });

  it('does not overwrite the reason the park clock wrote', async () => {
    const sid = await expiredPark();
    const job = await jobUnder(sid);

    expect(await deadlineSweep()).toBe(1);
    await runnerConfirmedTheKill(job);
    await reapSessionLostJobs(new Date(), { projectId });

    expect(await sessionState(sid)).toEqual({ status: 'failed', reason: 'park_unanswered' });
  });

  it('is still retried when the session simply died', async () => {
    const sid = await parkedSession(60);
    const job = await jobUnder(sid);
    await harness.db.execute(sql`
      UPDATE agent_sessions SET status = 'failed', failure_reason = 'residency_expired'
       WHERE id = ${sid}
    `);
    await runnerConfirmedTheKill(job);
    await reapSessionLostJobs(new Date(), { projectId });

    expect(await jobState(job)).toMatchObject({ error: 'session_lost', kind: 'infra' });
    expect(await retriesOf(job)).toBeGreaterThan(0);
  });
});

/**
 * The THIRD clock over a park, and the one nothing exempted.
 *
 * A run session carries no job and its `issue_id` is NULL, which a DB check
 * constraint makes incompatible with `kind = 'issue'` — so `reapJoblessRuns`
 * can never see one and `reapOrphanedOneShotRuns` is what owns the shape. That
 * sweep judges liveness on `last_heartbeat_at`, and parking FREEZES that
 * column, so a park that is alive and waiting is indistinguishable from a
 * session that died three minutes ago.
 */
describe('the one-shot orphan sweep over a processless park', () => {
  async function parkOnARunSession(): Promise<{ sessionId: string; runId: string }> {
    const sessionId = await parkedSession(60 * 24);
    await question(sessionId, { blockerKind: 'human', deadline: null });
    const [row] = await harness.db.execute<{ pipeline_run_id: string }>(
      sql`SELECT pipeline_run_id FROM agent_sessions WHERE id = ${sessionId}`,
    );
    return { sessionId, runId: row?.pipeline_run_id ?? '' };
  }

  async function runStatus(id: string): Promise<string> {
    const [row] = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM pipeline_runs WHERE id = ${id}`,
    );
    return row?.status ?? 'gone';
  }

  const sweep = (): Promise<unknown> => reapOrphanedOneShotRuns(new Date(), { projectId });

  it('leaves a live park alone however long its heartbeat has been frozen', async () => {
    const { sessionId, runId } = await parkOnARunSession();

    await sweep();

    expect((await sessionState(sessionId)).status).toBe('running');
    expect(await runStatus(runId)).toBe('running');
  });

  it('still reaps a jobless run whose session died with no park open', async () => {
    const sessionId = await parkedSession(60 * 24);
    const [row] = await harness.db.execute<{ pipeline_run_id: string }>(
      sql`SELECT pipeline_run_id FROM agent_sessions WHERE id = ${sessionId}`,
    );

    await sweep();

    expect((await sessionState(sessionId)).reason).toBe('heartbeat_timeout');
    expect(await runStatus(row?.pipeline_run_id ?? '')).toBe('failed');
  });

  it('still reaps a machine park, whose process is held rather than released', async () => {
    const sessionId = await parkedSession(60 * 24);
    await question(sessionId, { blockerKind: 'machine', deadline: null });

    await sweep();

    expect((await sessionState(sessionId)).reason).toBe('heartbeat_timeout');
  });
});
