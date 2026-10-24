/**
 * ISS-577 (REQ-74 BC-4) — the hold the automatic release recorded on a row at `awaiting_release` is
 * served where the issue is read: the issue read answers it whole, and the standing reads it as
 * the reason the row waits and on whom. The hold is written by its one writer
 * (`release-batch/hold.ts:writeReleaseHolds`) and read back through the real routes; a row with no
 * hold, a cleared hold and a hold on a row that has left the gate read none.
 *
 * @direct-test-of packages/core/src/release-batch/hold.ts
 * @direct-test-of packages/core/src/issues/standing-read.ts
 * @direct-test-of packages/core/src/issues/project-issue-routes.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NO_RELEASE_GATE_HOLD,
  queuedBehindHold,
  type ReleaseHold,
  writeReleaseHolds,
} from '../../src/release-batch/hold.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, seedIssueStatus } from '../helpers/factories.js';

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';

async function atGate(title: string): Promise<{ id: string; key: string }> {
  const made = ok(await say('owner', 'POST', `/api/projects/${projectId}/issues`, { title }), 201);
  await seedIssueStatus(made.id as string, 'awaiting_release');
  return { id: made.id as string, key: made.displayId as string };
}

const hold = (issueId: string, h: ReleaseHold) =>
  writeReleaseHolds({ projectId, issueIds: [issueId], holdFor: () => h, now: new Date() });

const detail = async (id: string): Promise<Doc> =>
  ok(await say('owner', 'GET', `/api/issues/${id}`));
const standing = async (key: string): Promise<Doc> =>
  ok(await say('owner', 'GET', `/api/projects/${projectId}/issues/standing/${key}`)).standing;

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const owner = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(owner)).id;
  say = requester(app, { owner: await signUserToken(owner) });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a release hold on the issue read (criterion 1)', () => {
  it('answers the hold code, reason, who owes the next act and what it waits for', async () => {
    const held = await atGate('held for a person');
    expect(await hold(held.id, NO_RELEASE_GATE_HOLD)).toMatchObject({ written: 1 });

    const read = await detail(held.id);
    expect(read.releaseHold).toMatchObject({
      code: 'NO_RELEASE_GATE',
      reason: NO_RELEASE_GATE_HOLD.reason,
      owes: 'human',
      waitingFor: NO_RELEASE_GATE_HOLD.waitingFor,
    });
    expect(Number.isNaN(Date.parse(read.releaseHold.heldAt))).toBe(false);
  });

  it('answers none for a cleared hold, and none once the row left the gate', async () => {
    const { clearReleaseHolds } = await import('../../src/release-batch/hold.js');
    const cleared = await atGate('hold cleared');
    await hold(cleared.id, NO_RELEASE_GATE_HOLD);
    await clearReleaseHolds([cleared.id]);
    expect((await detail(cleared.id)).releaseHold).toBeNull();

    // the stale sweep has not run yet: the record still stands, the wait it described does not
    const left = await atGate('left the gate');
    await hold(left.id, NO_RELEASE_GATE_HOLD);
    await seedIssueStatus(left.id, 'reopen');
    expect((await detail(left.id)).releaseHold).toBeNull();
    expect((await standing(left.key)).releaseHold).toBeNull();
  });
});

describe('a release hold on the standing (criterion 2)', () => {
  it('reads a hold a person owes as stuck on that person, its code and reason the rule', async () => {
    const held = await atGate('stuck for a person');
    await hold(held.id, NO_RELEASE_GATE_HOLD);

    const s = await standing(held.key);
    expect(s.releaseHold).toMatchObject({ code: 'NO_RELEASE_GATE', owes: 'human' });
    expect(s.attentionGroup).toBe('stuck');
    expect(s.waitingOn.kind).toBe('you');
    expect(s.waitingOn.act).toBe(NO_RELEASE_GATE_HOLD.waitingFor);
    expect(s.waitingOn.rule).toContain('NO_RELEASE_GATE');
    expect(s.waitingOn.rule).toContain('declares no production environment');
    expect(s.waitingOn.act).not.toBe('next release');
  });

  it('reads a hold the release owes as queued on the release, its code the rule', async () => {
    const held = await atGate('queued behind');
    await hold(held.id, queuedBehindHold(5));

    const s = await standing(held.key);
    expect(s.releaseHold).toMatchObject({ code: 'RELEASE_QUEUED_BEHIND', owes: 'agent' });
    expect(s.attentionGroup).toBe('queued');
    expect(s.waitingOn.kind).toBe('release');
    expect(s.waitingOn.act).toBe('a later automatic release');
    expect(s.waitingOn.rule).toContain('RELEASE_QUEUED_BEHIND');
  });
});

describe('an issue with no release hold (criterion 3)', () => {
  it('keeps its standing whole while another row is held, and shows no hold', async () => {
    const free = await atGate('nothing holds it');
    const before = await standing(free.key);
    expect(before.releaseHold).toBeNull();
    expect((await detail(free.id)).releaseHold).toBeNull();

    const other = await atGate('held beside it');
    await hold(other.id, NO_RELEASE_GATE_HOLD);

    const after = await standing(free.key);
    expect(after).toEqual(before);
    // its own rule still reads: no release note written yet, so the master writes it
    expect(after.waitingOn).toMatchObject({ kind: 'master', act: 'write the release note' });
    expect(after.waitingOn.rule).not.toContain('NO_RELEASE_GATE');
  });
});
