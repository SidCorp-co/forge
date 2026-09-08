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
