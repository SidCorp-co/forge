/**
 * ISS-933 criterion 21 — an idle master survives every sweep that can see it.
 *
 * Deleting the supervision cluster made 60 idle minutes a legal state for the
 * first time, so what used to be theoretical is now the steady state of a quiet
 * project. This asserts it against the reapers BY NAME rather than by argument:
 * each one is imported and run, and the master is read back afterwards.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let mods: {
  ensureMasterSession: typeof import('../../src/devices/master-session.js').ensureMasterSession;
  reapDeadMasterHolds: typeof import('../../src/devices/master-reaper.js').reapDeadMasterHolds;
  reapExpiredParks: typeof import('../../src/jobs/park-deadline.js').reapExpiredParks;
  reapZombieSessions: typeof import('../../src/jobs/loop-monitor.js').reapZombieSessions;
  reapDeadRunSessions: typeof import('../../src/devices/run-session-reaper.js').reapDeadRunSessions;
  reapUnansweredParks: typeof import('../../src/jobs/park-deadline.js').reapUnansweredParks;
  openRunSession: typeof import('../../src/devices/run-session.js').openRunSession;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  const masterSession = await import('../../src/devices/master-session.js');
  const masterReaper = await import('../../src/devices/master-reaper.js');
  const park = await import('../../src/jobs/park-deadline.js');
  const loop = await import('../../src/jobs/loop-monitor.js');
  const runReaper = await import('../../src/devices/run-session-reaper.js');
  mods = {
    ensureMasterSession: masterSession.ensureMasterSession,
    reapDeadMasterHolds: masterReaper.reapDeadMasterHolds,
    reapExpiredParks: park.reapExpiredParks,
    reapZombieSessions: loop.reapZombieSessions,
    reapDeadRunSessions: runReaper.reapDeadRunSessions,
    reapUnansweredParks: park.reapUnansweredParks,
    openRunSession: (await import('../../src/devices/run-session.js')).openRunSession,
  };
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

/** A master that has been resident for an hour with nothing to do. */
async function anIdleMaster(opts: { beating: boolean }) {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  const device = await createTestDevice(harness.db, user.id);
  const master = await mods.ensureMasterSession({
    deviceId: device.id,
    projectId: project.id,
    name: 'forge-master-quiet',
  });
  const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  // cm:why `beating: false` is a box slowed to `LIMITED_POLL_INTERVAL` between two re-registrations — the only thing that moves a resident master's heartbeat.
  await harness.db.execute(sql`
    UPDATE agent_sessions
    SET started_at = ${hourAgo}, created_at = ${hourAgo},
        last_heartbeat_at = ${opts.beating ? new Date().toISOString() : hourAgo},
        updated_at = ${hourAgo}
    WHERE id = ${master.sessionId}
  `);
  return { project, device, master };
}

async function statusOf(sessionId: string): Promise<string> {
  const [row] = (await harness.db.execute(sql`
    SELECT status FROM agent_sessions WHERE id = ${sessionId}
  `)) as unknown as Array<Record<string, unknown>>;
  return String(row?.status);
}

describe('a master idle for 60 minutes', () => {
  it('is left alone by every reaper that can see an agent_sessions row', async () => {
    const { master } = await anIdleMaster({ beating: true });

    await mods.reapExpiredParks();
    expect(
      await statusOf(master.sessionId),
      "`jobs/park-deadline.ts` must not reach a master. NOTE the reason is NOT the one criterion 21 was written on — since ISS-919 a master DOES write an `agent_sessions` row (`ensureMasterSession`). What actually holds is the predicate: this hop requires `runtime_state = 'awaiting_input'`, and a master never parks (ISS-933 criterion 21)",
    ).toBe('running');

    await mods.reapDeadMasterHolds();
    expect(
      await statusOf(master.sessionId),
      '`devices/master-reaper.ts` writes `jobs.held_by` and nothing else, so it can end a master HOLD but never a master session (ISS-933 criterion 21)',
    ).toBe('running');

    await mods.reapDeadRunSessions();
    expect(
      await statusOf(master.sessionId),
      "`devices/run-session-reaper.ts` is scoped to `metadata.type = 'run_session'`; a master carries `master` and must be invisible to it (ISS-933 criteria 21 and 25a)",
    ).toBe('running');

    await mods.reapZombieSessions();
    expect(await statusOf(master.sessionId)).toBe('running');
  });

  it('survives its own box being slowed between two re-registrations', async () => {
    const { master } = await anIdleMaster({ beating: false });

    await mods.reapZombieSessions();

    expect(
      await statusOf(master.sessionId),
      "the no-client hop in `jobs/loop-monitor.ts` matches every term a master satisfies — `running`, `claude_session_id IS NULL`, a type outside ('pipeline','pm') — and its 3-minute heartbeat is SHORTER than the 5-minute `LIMITED_POLL_INTERVAL` a rate-limited box re-registers on. Reaping here fails a healthy master, mints it a second session row, and leaves the pane claiming under an id core calls dead (ISS-933 criterion 21)",
    ).toBe('running');
  });
});

/** A session that released its process and has been waiting past its deadline. */
async function aSessionWaitingOnAPerson(
  projectId: string,
  deviceId: string,
  type: 'run_session' | null,
): Promise<string> {
  const run = await mods.openRunSession({
    deviceId,
    projectId,
    issueKeys: ['ISS-964'],
    name: 'grp-parked',
  });
  await harness.db.execute(sql`
    UPDATE agent_sessions
    SET metadata = ${type === null ? sql`'{}'::jsonb` : sql`${JSON.stringify({ type })}::jsonb`},
        created_at = now() - interval '3 days', last_heartbeat_at = now() - interval '3 days'
    WHERE id = ${run.sessionId}
  `);
  await harness.db.execute(sql`
    INSERT INTO agent_questions
      (id, project_id, agent_session_id, status, blocker_kind, steps,
       park_deadline_at, created_at, updated_at)
    VALUES (gen_random_uuid(), ${projectId}, ${run.sessionId}, 'open', 'human',
            '[]'::jsonb, now() - interval '1 hour', now() - interval '3 days',
            now() - interval '3 days')
  `);
  return run.sessionId;
}

// cm:why the reaper list below is ISS-933 criterion 21's, measured in the block above and cited rather than re-derived — ISS-964 criterion 45 asks for the 60-minute window proved safe against those same sweeps for a master that is WAITING on a person rather than merely idle, which is the one state that block could not produce.
describe('a master waiting on a person inside its 60-minute window', () => {
  it('is not reaped by the park deadline, because a master keeps its process', async () => {
    const { project, master } = await anIdleMaster({ beating: true });
    await harness.db.execute(sql`
      INSERT INTO agent_questions
        (id, project_id, agent_session_id, status, blocker_kind, steps,
         park_deadline_at, created_at, updated_at)
      VALUES (gen_random_uuid(), ${project.id}, ${master.sessionId}, 'open', 'human',
              '[]'::jsonb, now() - interval '1 hour', now() - interval '3 days',
              now() - interval '3 days')
    `);

    const closed = await mods.reapUnansweredParks();

    expect(
      closed,
      "a master asking a person is `parkedOnAHuman` by that predicate's own terms — an open question with `blocker_kind = 'human'` — but it did NOT release its process, so the asker's deadline is not its clock. Its own idle window is (ISS-964 criteria 43, 45)",
    ).toBe(0);
    expect(
      await statusOf(master.sessionId),
      'failing a master whose pane is still running is ISS-933 criterion 21 exactly: core mints it a second session row and the pane goes on claiming under an id core calls dead',
    ).toBe('running');
  });

  // cm:guard the falsifying half, and it is what stops the exclusion above being a hole: a RUN session in the same state must still be reaped, or criterion 34's loud close becomes a park under no clock at all.
  it('still reaps a run session in exactly that state', async () => {
    const { project, device } = await anIdleMaster({ beating: true });
    const sessionId = await aSessionWaitingOnAPerson(project.id, device.id, 'run_session');

    expect(
      await mods.reapUnansweredParks(),
      'the same row shape on a session that DID release its process is the park this clock exists for',
    ).toBe(1);
    expect(await statusOf(sessionId)).toBe('failed');
  });

  // cm:guard a session whose metadata carries no `type` at all must keep its clock. `NOT IN ('master')` is NULL for a NULL left side and PostgreSQL drops the row, which would exempt every untyped session silently — a park under no clock, which is the one outcome criteria 24 and 34 forbid together.
  it('keeps the clock on a session whose type is not recorded', async () => {
    const { project, device } = await anIdleMaster({ beating: true });
    await aSessionWaitingOnAPerson(project.id, device.id, null);

    expect(await mods.reapUnansweredParks()).toBe(1);
  });
});
