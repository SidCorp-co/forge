/**
 * ISS-933 criteria 13 + 14 — the two facts the close loop is allowed to read.
 *
 * The runner may set a mark only from a fact it read back, and these are the
 * two reads it makes: is my session terminal, and is this ONE issue still held.
 * They need a real Postgres because the lease is a `jsonb` membership on a live
 * row and the whole point is that a return removes one key and leaves the rest.
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
  readRunSessionTerminal: typeof import('../../src/devices/run-session.js').readRunSessionTerminal;
  isIssueLeaseHeld: typeof import('../../src/devices/run-session.js').isIssueLeaseHeld;
  releaseIssueLease: typeof import('../../src/devices/run-session.js').releaseIssueLease;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  const runSession = await import('../../src/devices/run-session.js');
  mods = {
    openRunSession: runSession.openRunSession,
    readRunSessionTerminal: runSession.readRunSessionTerminal,
    isIssueLeaseHeld: runSession.isIssueLeaseHeld,
    releaseIssueLease: runSession.releaseIssueLease,
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

async function anotherBox() {
  const user = await createTestUser(harness.db);
  return createTestDevice(harness.db, user.id);
}

describe('a declaration retried after a lost answer', () => {
  // cm:guard this is the failure this whole issue is about, arriving from inside the fix. The box
  // writes its ledger row and then calls core; if core commits and the answer never gets back — a
  // timeout, a dropped connection, a write-back that failed on the box — the box still has no
  // session id and its next sweep sends the same declaration again. A second session there leaves
  // the first with nothing beating it, so core reaps it after ten minutes and `returnIssuesForRun`
  // pulls those issues back from under the live duplicate (ISS-1050).
  it('is answered with the session core already has, rather than a second one', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const device = await createTestDevice(harness.db, user.id);
    const declaration = {
      deviceId: device.id,
      projectId: project.id,
      issueKeys: ['ISS-1', 'ISS-2'],
      name: 'run-a',
      boxRunId: '11111111-1111-4111-8111-111111111111',
    };

    const first = await mods.openRunSession(declaration);
    const retry = await mods.openRunSession(declaration);

    expect(retry).toEqual(first);
    const counted = (await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM agent_sessions WHERE device_id = ${device.id}`,
    )) as unknown as { n: number }[];
    expect(
      counted[0]?.n,
      'a retried declaration must leave exactly one session, not one per attempt',
    ).toBe(1);
  });

  // cm:guard scoped by DEVICE as well, because a run id is minted on the box: unscoped, one box's
  // retry would be handed another box's session and would then beat, close and release issues it
  // never held.
  it('does not hand one box the session another box opened under the same run id', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const deviceA = await createTestDevice(harness.db, user.id);
    const deviceB = await createTestDevice(harness.db, user.id);
    const boxRunId = '22222222-2222-4222-8222-222222222222';

    const a = await mods.openRunSession({
      deviceId: deviceA.id,
      projectId: project.id,
      issueKeys: ['ISS-1'],
      name: 'run-a',
      boxRunId,
    });
    const b = await mods.openRunSession({
      deviceId: deviceB.id,
      projectId: project.id,
      issueKeys: ['ISS-2'],
      name: 'run-b',
      boxRunId,
    });

    expect(b.sessionId).not.toBe(a.sessionId);
  });

  // cm:guard a retry whose earlier session has already been closed or reaped is a genuinely NEW run
  // of the same work. Handing it the dead session would give it one nothing beats — reaped again
  // ten minutes later, returning issues from under a run that is working.
  it('opens a fresh session when the one that box run had is already terminal', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const device = await createTestDevice(harness.db, user.id);
    const declaration = {
      deviceId: device.id,
      projectId: project.id,
      issueKeys: ['ISS-1'],
      name: 'run-a',
      boxRunId: '33333333-3333-4333-8333-333333333333',
    };

    const first = await mods.openRunSession(declaration);
    await harness.db.execute(
      sql`UPDATE agent_sessions SET status = 'failed' WHERE id = ${first.sessionId}`,
    );
    const second = await mods.openRunSession(declaration);

    expect(second.sessionId).not.toBe(first.sessionId);
  });

  // cm:guard every test above sends its retry AFTER the first call returned, so the first row is
  // always committed by the time the second one looks: a plain read-then-create passes all three.
  // The duplicate arrives when two declarations for one box run are in flight at once — a sweep
  // that overlapped its predecessor, a route the box's HTTP client retried while the first request
  // is still open — and BOTH read before either commits. This is the case that tells the atomic
  // claim apart from the check that preceded it (ISS-1050).
  //
  // cm:guard the race is CONSTRUCTED, not raced for. Firing N calls at once and hoping they
  // interleave is not evidence: measured on this box, eight simultaneous declarations against the
  // unlocked code produced eight sessions when the test ran alone and exactly one when it ran after
  // its neighbours, because a warm `postgres.js` pool serialises transactions once its connections
  // are all reserved. That green was indistinguishable from a strong one. So the test takes the
  // claim's own advisory lock first, and what it asserts is that both callers BLOCK on it — which
  // an unlocked `openRunSession` cannot do, whatever the pool is doing.
  it('makes two declarations of one box run wait on each other and answer alike', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const device = await createTestDevice(harness.db, user.id);
    const boxRunId = '44444444-4444-4444-8444-444444444444';
    const declaration = {
      deviceId: device.id,
      projectId: project.id,
      issueKeys: ['ISS-1', 'ISS-2'],
      name: 'run-a',
      boxRunId,
    };

    let releaseTheLock = () => {};
    const lockHeld = new Promise<void>((resolve) => {
      releaseTheLock = resolve;
    });
    const holder = harness.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`run-session:${device.id}:${boxRunId}`}, 0))`,
      );
      await lockHeld;
    });

    const settled: string[] = [];
    const first = mods.openRunSession({ ...declaration }).then((r) => {
      settled.push('first');
      return r;
    });
    const second = mods.openRunSession({ ...declaration }).then((r) => {
      settled.push('second');
      return r;
    });
    await new Promise((r) => setTimeout(r, 500));

    expect(
      settled,
      'a declaration that answers while another holds the box run key has not claimed it — it has read around it',
    ).toEqual([]);

    releaseTheLock();
    await holder;
    const [a, b] = await Promise.all([first, second]);

    expect(
      b.sessionId,
      'the loser of the race must be answered with the winner session, not one of its own',
    ).toBe(a.sessionId);

    const sessions = (await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM agent_sessions WHERE device_id = ${device.id}`,
    )) as unknown as { n: number }[];
    expect(
      sessions[0]?.n,
      'a second session has nothing beating it, so core reaps it and returns issues from under the live run',
    ).toBe(1);

    const runs = (await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM pipeline_runs
           WHERE kind = 'system' AND metadata->>'boxRunId' = ${boxRunId}`,
    )) as unknown as { n: number }[];
    expect(runs[0]?.n, 'one box run is one run row, however many requests carried it').toBe(1);
  });
});

describe('the session-terminal read-back', () => {
  it('answers false while the row says running, and true once it does not', async () => {
    const { device, session } = await aBoxWithARun(['ISS-1', 'ISS-2']);
    const args = { deviceId: device.id, sessionId: session.sessionId };

    expect(
      await mods.readRunSessionTerminal(args),
      'a live session read as terminal closes the loop over an agent that is still writing (ISS-933 criterion 13)',
    ).toBe(false);

    await harness.db.execute(
      sql`UPDATE agent_sessions SET status = 'completed' WHERE id = ${session.sessionId}`,
    );

    expect(await mods.readRunSessionTerminal(args)).toBe(true);
  });

  it('refuses a session belonging to another box rather than answering for it', async () => {
    const { session } = await aBoxWithARun(['ISS-1']);
    const other = await anotherBox();

    expect(
      await mods.readRunSessionTerminal({ deviceId: other.id, sessionId: session.sessionId }),
      'a box that can read another box session can close the loop over it, which is the cross-box exclusion undone from the inside',
    ).toBeNull();
  });
});

describe('the lease is held per issue, and returned per issue', () => {
  it('reports every issue of the group held while the run lives', async () => {
    const { device } = await aBoxWithARun(['ISS-1', 'ISS-2', 'ISS-3']);

    for (const issueKey of ['ISS-1', 'ISS-2', 'ISS-3']) {
      expect(await mods.isIssueLeaseHeld({ deviceId: device.id, issueKey })).toBe(true);
    }
    expect(await mods.isIssueLeaseHeld({ deviceId: device.id, issueKey: 'ISS-9' })).toBe(false);
  });

  it('returns exactly one and leaves the rest of the group held', async () => {
    const { device } = await aBoxWithARun(['ISS-1', 'ISS-2', 'ISS-3']);

    await mods.releaseIssueLease({ deviceId: device.id, issueKey: 'ISS-2' });

    expect(
      await mods.isIssueLeaseHeld({ deviceId: device.id, issueKey: 'ISS-2' }),
      'the return is proved by asking again, never by the response to the return (ISS-933 criterion 13)',
    ).toBe(false);
    expect(
      [
        await mods.isIssueLeaseHeld({ deviceId: device.id, issueKey: 'ISS-1' }),
        await mods.isIssueLeaseHeld({ deviceId: device.id, issueKey: 'ISS-3' }),
      ],
      'a run that returned one of three must read as exactly that — a release that emptied the group makes a partial return indistinguishable from a clean one (ISS-933 criterion 14)',
    ).toEqual([true, true]);
  });

  it('is idempotent — returning the same lease twice removes nothing more and does not throw', async () => {
    const { device } = await aBoxWithARun(['ISS-1', 'ISS-2']);

    await mods.releaseIssueLease({ deviceId: device.id, issueKey: 'ISS-1' });
    await mods.releaseIssueLease({ deviceId: device.id, issueKey: 'ISS-1' });

    expect(
      await mods.isIssueLeaseHeld({ deviceId: device.id, issueKey: 'ISS-2' }),
      'the close loop retries every mark it still owes, so a repeated return must be a no-op rather than a write that takes the rest of the group with it',
    ).toBe(true);
  });

  it('reads a lease as returned once the session itself is terminal', async () => {
    const { device, session } = await aBoxWithARun(['ISS-1']);

    await harness.db.execute(
      sql`UPDATE agent_sessions SET status = 'failed' WHERE id = ${session.sessionId}`,
    );

    expect(
      await mods.isIssueLeaseHeld({ deviceId: device.id, issueKey: 'ISS-1' }),
      'a lease held by a session core has already reaped is not held — reading the run row alone would have the box retrying a return with nothing left to return',
    ).toBe(false);
  });

  it('will not release an issue held by another box', async () => {
    const { device } = await aBoxWithARun(['ISS-1']);
    const other = await anotherBox();

    await mods.releaseIssueLease({ deviceId: other.id, issueKey: 'ISS-1' });

    expect(await mods.isIssueLeaseHeld({ deviceId: device.id, issueKey: 'ISS-1' })).toBe(true);
  });
});
