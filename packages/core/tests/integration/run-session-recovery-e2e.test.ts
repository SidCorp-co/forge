/**
 * ISS-933 criterion 25a — a whole box lost, recovered from core.
 *
 * The local ledger cannot answer for a runner that has lost power, which is
 * the failure `master-reaper.ts`'s own header names. These assertions need a
 * real Postgres because the thing under test is a clock in the database: a
 * heartbeat that stops because nobody is left to send it.
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
  openRunSession: typeof import('../../src/devices/run-session.js').openRunSession;
  runSessionIssues: typeof import('../../src/devices/run-session.js').runSessionIssues;
  listRunSessionsForDevice: typeof import('../../src/devices/run-session.js').listRunSessionsForDevice;
  reapDeadRunSessions: typeof import('../../src/devices/run-session-reaper.js').reapDeadRunSessions;
  RUN_SESSION_TIMEOUT_MS: typeof import('../../src/devices/run-session-reaper.js').RUN_SESSION_TIMEOUT_MS;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  const runSession = await import('../../src/devices/run-session.js');
  const reaper = await import('../../src/devices/run-session-reaper.js');
  mods = {
    openRunSession: runSession.openRunSession,
    runSessionIssues: runSession.runSessionIssues,
    listRunSessionsForDevice: runSession.listRunSessionsForDevice,
    reapDeadRunSessions: reaper.reapDeadRunSessions,
    RUN_SESSION_TIMEOUT_MS: reaper.RUN_SESSION_TIMEOUT_MS,
  };
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function aBoxWithARun(issueKeys: string[]) {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  const device = await createTestDevice(harness.db, user.id);
  const session = await mods.openRunSession({
    deviceId: device.id,
    projectId: project.id,
    issueKeys,
    name: 'run-a',
  });
  return { user, project, device, session };
}

/** The box stops answering: nothing on it writes, so only its clock moves. */
async function boxGoesDark(sessionId: string) {
  const ago = new Date(Date.now() - mods.RUN_SESSION_TIMEOUT_MS - 60_000).toISOString();
  await harness.db.execute(sql`
    UPDATE agent_sessions SET last_heartbeat_at = ${ago}, updated_at = ${ago}
    WHERE id = ${sessionId}
  `);
}

describe('a run session carries a group of issues', () => {
  it('records the group without ever naming one of them on the run', async () => {
    const { session } = await aBoxWithARun(['ISS-957', 'ISS-958']);

    expect(await mods.runSessionIssues(session.sessionId)).toEqual(['ISS-957', 'ISS-958']);

    const [row] = (await harness.db.execute(sql`
      SELECT issue_id, kind FROM pipeline_runs WHERE id = ${session.runId}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(
      row?.issue_id,
      'a run carrying two issues that names one of them on `issue_id` has recorded a lie no index can catch — the partial unique index does not apply at kind=system (ISS-933 criterion 25a)',
    ).toBeNull();
    expect(row?.kind).toBe('system');
  });
});

describe('a box that never comes back', () => {
  it('has its whole group released from core, with the box never reporting anything', async () => {
    const { session } = await aBoxWithARun(['ISS-957', 'ISS-958']);
    await boxGoesDark(session.sessionId);

    const reaped = await mods.reapDeadRunSessions();

    expect(
      reaped.map((r) => r.sessionId),
      'a design in which the unreachable box is the only thing that can release its own work fails criterion 25a however well it handles a dead pane — this box reported NOTHING, and its session is still `running` because nobody was left to change it (ISS-933 criterion 25a)',
    ).toEqual([session.sessionId]);
    expect(reaped[0]?.issueKeys).toEqual(['ISS-957', 'ISS-958']);
  });

  it('leaves neither the session nor its run non-terminal', async () => {
    const { device, session } = await aBoxWithARun(['ISS-957']);
    await boxGoesDark(session.sessionId);

    await mods.reapDeadRunSessions();

    const [s] = (await harness.db.execute(sql`
      SELECT status FROM agent_sessions WHERE id = ${session.sessionId}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(
      ['completed', 'failed', 'cancelled'],
      'a run whose issues came back while its session still reads `running` is the state-never-lies failure exactly: the pool shows work in flight that no box is doing (ISS-933 criterion 25a)',
    ).toContain(String(s?.status));

    const [r] = (await harness.db.execute(sql`
      SELECT status FROM pipeline_runs WHERE id = ${session.runId}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(['completed', 'failed', 'cancelled']).toContain(String(r?.status));

    expect(await mods.listRunSessionsForDevice(device.id)).toEqual([]);
  });

  it('leaves a run whose box is still beating alone', async () => {
    await aBoxWithARun(['ISS-957']);

    const reaped = await mods.reapDeadRunSessions();

    expect(
      reaped,
      'a sweep that takes a beating box’s work back is the mirror failure — it costs an operator the diff in a live worktree (ISS-933 criterion 25a)',
    ).toEqual([]);
  });

  it('sweeps twice without releasing the same group twice', async () => {
    const { session } = await aBoxWithARun(['ISS-957']);
    await boxGoesDark(session.sessionId);

    await mods.reapDeadRunSessions();
    const again = await mods.reapDeadRunSessions();

    expect(
      again,
      'a reaper that keeps finding a run it has already released logs a release per minute forever and cannot be read as a fleet health signal (ISS-933 criterion 25a)',
    ).toEqual([]);
  });
});
