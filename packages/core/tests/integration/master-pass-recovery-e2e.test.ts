import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

// ISS-276 / FB-87: passes were refused from 16:02Z to 16:34Z and the nudge at 16:42Z ran. The
// first pass that ran after the refusals is marked as the recovery, so the real resume time is read
// from it rather than from the reset the account printed.

type Who = 'owner' | 'box' | 'otherBox';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const deviceId = await createTestDevice(ownerId);
  const otherDevice = await createTestDevice(ownerId);
  await bindTestRunner(projectId, deviceId);
  await bindTestRunner(projectId, otherDevice);
  const box = (who: string, device: string) =>
    mintPat({ userId: ownerId, name: who, deviceId: device, projectIds: [projectId] });
  say = requester(app, {
    owner: await signUserToken(ownerId),
    box: (await box('box', deviceId)).plaintext,
    otherBox: (await box('other', otherDevice)).plaintext,
  }) as typeof say;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const at = (path: string) => `/api/projects/${projectId}${path}`;

async function masterSession(who: Who): Promise<string> {
  return ok(
    await say(who, 'POST', '/api/devices/me/master-session', {
      projectId,
      name: `forge-master-${who}`,
      maxJobPanes: 1,
    }),
  ).sessionId as string;
}

const REFUSAL = {
  reason: 'usage_limit',
  detail: "You've hit your session limit · resets 2:30am (Asia/Ho_Chi_Minh)",
};

/** Open a pass and settle it as a turn that ended: refused before it ran, ran, or abandoned. */
async function aPass(
  who: Who,
  sessionId: string,
  how: 'refused' | 'ran' | 'abandoned',
): Promise<Doc> {
  const pass = (body: Doc) => say(who, 'POST', '/api/devices/me/master-session/pass', body);
  const opened = ok(await pass({ op: 'open', sessionId, verb: 'dispatch' }), 201).pass;
  const facts =
    how === 'abandoned'
      ? {
          openedBy: 'adopted',
          served: true,
          openedAgoMs: 1_000,
          hooks: null,
          writtenAgoMs: null,
          dispatched: [],
          record: { worked: false, refusal: null },
        }
      : {
          openedBy: 'this_daemon',
          served: true,
          openedAgoMs: 5_000,
          hooks: { turnsSinceOpen: 1, turnBeganAgoMs: 4_000, doing: 'idle', lastEventAgoMs: 1_000 },
          writtenAgoMs: null,
          dispatched: [],
          record:
            how === 'ran' ? { worked: true, refusal: null } : { worked: false, refusal: REFUSAL },
        };
  return ok(await pass({ op: 'settle', sessionId, passId: opened.id, facts })).pass;
}

describe('the first pass that ran after refused passes is marked as the recovery', () => {
  it('marks it with when the refusals began and how many passes they took, and marks no other', async () => {
    const sessionId = await masterSession('box');
    const before = await aPass('box', sessionId, 'ran');
    const first = await aPass('box', sessionId, 'refused');
    await aPass('box', sessionId, 'refused');
    await aPass('box', sessionId, 'abandoned');
    await aPass('box', sessionId, 'refused');
    const recovered = await aPass('box', sessionId, 'ran');
    const after = await aPass('box', sessionId, 'ran');

    const items: Doc[] = ok(await say('owner', 'GET', at('/masters/passes?limit=20'))).items;
    const byId = new Map(items.map((p) => [p.id, p]));
    expect(byId.get(recovered.id)?.recovers).toEqual({
      refusedSince: first.startedAt,
      refusedPasses: 3,
      reason: 'usage_limit',
    });
    expect(byId.get(first.id)?.refused).toEqual(REFUSAL);
    for (const other of items.filter((p) => p.id !== recovered.id && p.endedAt)) {
      expect(other.recovers, `pass ${other.id} is not the recovery`).toBeNull();
    }
    expect(byId.get(before.id)?.recovers).toBeNull();
    expect(byId.get(after.id)?.recovers).toBeNull();

    const standing = ok(await say('owner', 'GET', at('/masters/standing')));
    expect(standing.lastPass.id).toBe(after.id);
    expect(standing.lastPass.recovers).toBeNull();
  });

  it('serves the mark on standing while the recovery is the last pass', async () => {
    const sessionId = await masterSession('box');
    const refused = await aPass('box', sessionId, 'refused');
    expect(ok(await say('owner', 'GET', at('/masters/standing'))).lastPass).toMatchObject({
      id: refused.id,
      refused: REFUSAL,
      recovers: null,
    });
    const ran = await aPass('box', sessionId, 'ran');
    expect(ok(await say('owner', 'GET', at('/masters/standing'))).lastPass).toMatchObject({
      id: ran.id,
      recovers: { refusedSince: refused.startedAt, refusedPasses: 1, reason: 'usage_limit' },
    });
  });

  it('does not call a pass on another box the recovery of this box account', async () => {
    const mine = await masterSession('box');
    await aPass('box', mine, 'refused');
    const theirs = await masterSession('otherBox');
    const ran = await aPass('otherBox', theirs, 'ran');
    const items: Doc[] = ok(await say('owner', 'GET', at('/masters/passes?limit=5'))).items;
    expect(items.find((p) => p.id === ran.id)?.recovers).toBeNull();
  });
});
