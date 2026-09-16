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
  closeRunSession: typeof import('../../src/devices/run-session.js').closeRunSession;
  readAdmissibleIssues: typeof import('../../src/devices/admissible.js').readAdmissibleIssues;
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
  const admissible = await import('../../src/devices/admissible.js');
  mods = {
    openRunSession: runSession.openRunSession,
    closeRunSession: runSession.closeRunSession,
    readAdmissibleIssues: admissible.readAdmissibleIssues,
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

/** Wait until Postgres itself says both declarations are blocked on the box run key. */
//
//
async function bothAreWaitingOn(deviceId: string, boxRunId: string): Promise<void> {
  const key = `run-session:${deviceId}:${boxRunId}`;
  const deadline = Date.now() + 10_000;
  let seen = -1;
  while (Date.now() < deadline) {
    const rows = (await harness.db.execute(sql`
      SELECT count(*)::int AS n
        FROM pg_locks
       WHERE locktype = 'advisory'
         AND NOT granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND classid = ((hashtextextended(${key}, 0) >> 32) & 4294967295)::oid
         AND objid = (hashtextextended(${key}, 0) & 4294967295)::oid
    `)) as unknown as { n: number }[];
    seen = rows[0]?.n ?? 0;
    if (seen >= 2) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `both declarations should be BLOCKED on the box run key while the harness holds it; ` +
      `Postgres reports ${seen} waiter(s) after 10s. A declaration that does not wait on this key ` +
      `is reading around the claim rather than making it.`,
  );
}

describe('a declaration retried after a lost answer', () => {
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

  //
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
    await bothAreWaitingOn(device.id, boxRunId);

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

/**
 * ISS-1050 criterion 12 — an issue whose run died is OFFERED AGAIN.
 *
 * The exclusion half is proved elsewhere (`issue-prefix-e2e`: a live run's issue is not
 * admitted). Nothing proved the return half, which is the half this whole issue is named
 * after: if a dead run's session never leaves `running`, the issue it held is excluded from
 * the admissible set forever, and what an operator sees is an issue at `in_progress` that no
 * box will ever pick up again. That failure is indistinguishable from an empty backlog.
 */
describe('an issue whose run died', () => {
  async function aBacklogProject() {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const device = await createTestDevice(harness.db, user.id);
    await harness.db.execute(sql`
      UPDATE projects
         SET agent_config = ${JSON.stringify({
           pipelineConfig: { poolBacklog: { statuses: ['draft'], limit: 20 } },
         })}::jsonb
       WHERE id = ${project.id}
    `);
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, name, type, status)
      VALUES (gen_random_uuid(), ${project.id}, ${device.id}, 'r', 'claude-code', 'online')
    `);
    for (const seq of [880, 881]) {
      await harness.db.execute(sql`
        INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
        VALUES (gen_random_uuid(), ${project.id}, ${seq}, ${`issue ${seq}`}, 'draft', ${user.id})
      `);
    }
    return { user, project, device };
  }

  const keysFor = async (deviceId: string, projectId: string) =>
    (await mods.readAdmissibleIssues({ deviceId, projectId })).map((a) => a.issueKey);

  it('is offered again once the box reports the run died', async () => {
    const { project, device } = await aBacklogProject();
    const session = await mods.openRunSession({
      deviceId: device.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-that-dies',
    });

    // While it lives, it is somebody's work and must not be offered.
    expect(await keysFor(device.id, project.id)).toEqual(['ISS-881']);

    await mods.closeRunSession({
      deviceId: device.id,
      sessionId: session.sessionId,
      outcome: 'died',
      detail: 'the master pane is gone from this box',
    });

    const after = await keysFor(device.id, project.id);
    expect(after).toContain('ISS-880');
    expect(after).toContain('ISS-881');
  });

  it('is offered again whether the run died or ended', async () => {
    const { project, device } = await aBacklogProject();
    const session = await mods.openRunSession({
      deviceId: device.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-that-ends',
    });
    await mods.closeRunSession({
      deviceId: device.id,
      sessionId: session.sessionId,
      outcome: 'ended',
    });
    expect(await keysFor(device.id, project.id)).toContain('ISS-880');
  });

  it('is offered to a DIFFERENT box on the project too, not only the one that lost it', async () => {
    const { user, project, device } = await aBacklogProject();
    const second = await createTestDevice(harness.db, user.id);
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, name, type, status)
      VALUES (gen_random_uuid(), ${project.id}, ${second.id}, 'r2', 'claude-code', 'online')
    `);
    const session = await mods.openRunSession({
      deviceId: device.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-that-dies',
    });
    expect(await keysFor(second.id, project.id)).not.toContain('ISS-880');

    await mods.closeRunSession({
      deviceId: device.id,
      sessionId: session.sessionId,
      outcome: 'died',
    });

    expect(await keysFor(second.id, project.id)).toContain('ISS-880');
  });

  it('holds every issue of a group and offers every one of them back', async () => {
    const { project, device } = await aBacklogProject();
    const session = await mods.openRunSession({
      deviceId: device.id,
      projectId: project.id,
      issueKeys: ['ISS-880', 'ISS-881'],
      name: 'a-group',
    });
    expect(await keysFor(device.id, project.id)).toEqual([]);

    await mods.closeRunSession({
      deviceId: device.id,
      sessionId: session.sessionId,
      outcome: 'died',
    });

    const after = await keysFor(device.id, project.id);
    expect(after).toContain('ISS-880');
    expect(after).toContain('ISS-881');
  });
});
