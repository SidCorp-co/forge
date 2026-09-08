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

const MINUTES = 60_000;
// cm:guard ISO strings, never Date objects — postgres-js has no column type to bind a Date against inside a raw `sql` template and throws ERR_INVALID_ARG_TYPE.
const ago = (m: number): string => new Date(Date.now() - m * MINUTES).toISOString();
const ahead = (m: number): string => new Date(Date.now() + m * MINUTES).toISOString();

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  ({ reapExpiredParks, reapUnansweredParks } = await import('../../src/jobs/park-deadline.js'));
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
  // cm:guard 20 minutes is past the default 10min residency + 5min grace, so every case here would be reaped by the unexempted predicate. Drop the age and the exemption tests pass whether the clause is there or not.
  it('leaves a human park alone however long it waits', async () => {
    const id = await parkedSession(20);
    await question(id, { blockerKind: 'human' });

    expect(await residencySweep()).toBe(0);
    expect((await sessionState(id)).status).toBe('running');
  });

  // cm:guard THE falsifying case for the discriminator. `begin_question` is step one of both arms of `runner/blocked.rs`, so exempting on "an open question exists" would exempt this session too — and a machine park KEEPS its process, so residency's premise ("the runner failed to honour its ceiling") is exactly right for it.
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

  // cm:guard the regression the new clause could cause, and the honest form of the old-runner leg of criterion 27's matrix: a park minted before ISS-964 carries NO question row, and it must still be reaped. "The new code is inert when nothing changed" cannot go red; this can.
  it('still reaps a park that predates the question table', async () => {
    const id = await parkedSession(20);

    expect(await residencySweep()).toBe(1);
    expect(await sessionState(id)).toEqual({ status: 'failed', reason: 'residency_expired' });
  });

  // cm:guard the exemption follows the question being OPEN, not its existence. An answered question is a park that is over: the session is owed a revival, and if the runner never comes back for it residency is once again the right clock and the right reason.
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
  // cm:guard the wait is UNBOUNDED without a deadline the asker set (criterion 8), so a park with a NULL `park_deadline_at` must survive this sweep forever. Reading NULL as "expired" would silently cap the one wait the design promises has no limit.
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

  // cm:guard the reason names the number of DAYS waited, because that is what the person who never answered needs to read. A generic `expired` sends them to the runner logs for a stall that is not there — the same mistake `residency_expired` exists to avoid.
  it('closes an expired park loudly, naming the days it waited', async () => {
    const id = await parkedSession(60 * 24 * 3);
    const q = await question(id, {
      blockerKind: 'human',
      deadline: ago(30),
      askedMinutesAgo: 60 * 24 * 2,
    });

    expect(await deadlineSweep()).toBe(1);
    // cm:guard the session's cause is the FIXED taxonomy member and the days live on the question. A per-row reason in `failure_reason` lands every park in `unclassified` — `park_unanswered` has origin `user`, so it also stays out of the real-failure rate.
    expect(await sessionState(id)).toEqual({ status: 'failed', reason: 'park_unanswered' });
    expect(await questionState(q)).toEqual({
      status: 'expired',
      endedReason: 'unanswered_2d',
      endedBy: 'sweeper',
    });
  });

  // cm:guard a park asked and expired inside one day still reads `1d`, never `0d`: the floor is what keeps the reason a duration a person can act on rather than a rounding artefact.
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

  // cm:guard scoped to an OPEN question, which is also its idempotency: the sweep flips the row to `expired`, so a park it has closed stops matching and is never closed twice. No marker column.
  it('closes one park once', async () => {
    const id = await parkedSession(60 * 24);
    await question(id, { blockerKind: 'human', deadline: ago(30), askedMinutesAgo: 60 * 24 });

    expect(await deadlineSweep()).toBe(1);
    expect(await deadlineSweep()).toBe(0);
  });

  // cm:guard a machine park's deadline is NOT this clock's business — it keeps its process and residency already bounds it, so closing it here would make the recorded reason a coin flip between two sweeps.
  it('ignores a machine park that carries a deadline', async () => {
    const id = await parkedSession(60 * 24);
    await question(id, { blockerKind: 'machine', deadline: ago(30), askedMinutesAgo: 60 * 24 });

    expect(await deadlineSweep()).toBe(0);
  });
});
