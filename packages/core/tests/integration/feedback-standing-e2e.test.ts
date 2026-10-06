import { afterAll, beforeAll, describe, expect, it, type MockInstance, vi } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
  seedIssueStatus,
} from '../helpers/factories.js';

type Who = 'owner' | 'member' | 'viewer' | 'box';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let box = '';
let publish: MockInstance;
const ids = { target: '', low: '', high: '', medium: '', carrierKey: '', carrier: '' };

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { roomManager } = await import('../../src/lib/rooms.js');
  publish = vi.spyOn(roomManager, 'publish');
  const owner = (await createTestUser({ verified: true })).id;
  const member = (await createTestUser({ verified: true })).id;
  const viewer = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(owner)).id;
  await addProjectMember(projectId, member, 'member');
  await addProjectMember(projectId, viewer, 'viewer');
  box = await createTestDevice(owner);
  await bindTestRunner(projectId, box);
  const { issueDeviceCredential } = await import('../../src/devices/credential.js');
  say = requester(app, {
    owner: await signUserToken(owner),
    member: await signUserToken(member),
    viewer: await signUserToken(viewer),
    box: await issueDeviceCredential({ deviceId: box, holderUserId: owner }),
  });
  ids.target = ok(
    await say('owner', 'POST', `/api/projects/${projectId}/issues`, { title: 'The board view' }),
    201,
  ).id;
}, 120_000);

afterAll(async () => {
  publish?.mockRestore();
  await closeWorld();
});

const at = (path: string) => `/api/projects/${projectId}/feedback${path}`;

async function file(severity: string, title: string): Promise<string> {
  const made = ok(
    await say('member', 'POST', at(''), { kind: 'bug', severity, title, issue: ids.target }),
    201,
  );
  return made.feedback.key as string;
}

async function standingAs(who: Who, key: string): Promise<Doc> {
  const list = ok(await say(who, 'GET', at('')));
  const row = list.feedback.find((f: Doc) => f.key === key);
  expect(row, `${key} is on ${who}'s list`).toBeDefined();
  return { attentionGroup: row.attentionGroup, waitingOn: row.waitingOn };
}

async function feedbackWakes(): Promise<Doc[]> {
  await settleOutbox();
  return publish.mock.calls
    .map((c): Doc => ({ room: c[0], ...(c[1] as Doc) }))
    .filter((e) => e.event === 'master.wake' && e.data.source === 'feedback')
    .map((e) => ({ room: e.room, ...e.data }));
}

async function owedList(): Promise<Doc[]> {
  const read = ok(await say('box', 'GET', `/api/devices/me/feedback/owed?projectId=${projectId}`));
  return read.items.map((i: Doc) => ({ key: i.key, severity: i.severity }));
}

describe('with no live master, an untriaged item waits on a holder of feedback.approve', () => {
  it('is the owner’s own act, and its filing still wakes the bound box', async () => {
    await settleOutbox();
    publish.mockClear();
    ids.low = await file('low', 'The board drops a column on resize');
    expect(await standingAs('owner', ids.low)).toEqual({
      attentionGroup: 'needs_you',
      waitingOn: expect.objectContaining({ kind: 'you', who: 'You', act: 'triage it' }),
    });
    expect(await feedbackWakes()).toEqual([
      expect.objectContaining({ room: `device:${box}`, projectId, severity: 'low' }),
    ]);
  });

  it('names the permission to a member and a viewer who do not hold it', async () => {
    for (const who of ['member', 'viewer'] as const) {
      expect(await standingAs(who, ids.low)).toEqual({
        attentionGroup: 'waiting',
        waitingOn: expect.objectContaining({
          kind: 'person',
          who: 'A holder of feedback.approve',
          act: 'triage it',
        }),
      });
    }
  });

  it('does not name an absent master even for a high item', async () => {
    ids.high = await file('high', 'Saving the board loses every card');
    expect(await standingAs('owner', ids.high)).toEqual({
      attentionGroup: 'needs_you',
      waitingOn: expect.objectContaining({ kind: 'you', who: 'You', act: 'triage it' }),
    });
  });
});

describe('with a live master, every untriaged item is owed to it, most severe first', () => {
  beforeAll(async () => {
    const { ensureMasterSession } = await import('../../src/devices/master-session.js');
    await ensureMasterSession({ deviceId: box, projectId, name: 'master' });
  });

  it('wakes the master for a medium item and lists it between the high and the low', async () => {
    await settleOutbox();
    publish.mockClear();
    ids.medium = await file('medium', 'The board forgets its filter on reload');
    expect(await feedbackWakes()).toEqual([
      expect.objectContaining({ room: `device:${box}`, projectId, severity: 'medium' }),
    ]);
    expect(await owedList()).toEqual([
      { key: ids.high, severity: 'high' },
      { key: ids.medium, severity: 'medium' },
      { key: ids.low, severity: 'low' },
    ]);
  });

  it.each(['low', 'medium', 'high'] as const)(
    'reads a %s item as the master’s act, whoever reads it',
    async (severity) => {
      for (const who of ['owner', 'member'] as const) {
        expect(await standingAs(who, ids[severity])).toEqual({
          attentionGroup: 'moving',
          waitingOn: expect.objectContaining({ kind: 'agent', who: "The project's master" }),
        });
      }
    },
  );
});

describe('a high item is triaged onto an issue', () => {
  it('refuses a triage from a member who lacks feedback.approve', async () => {
    const res = await say('member', 'POST', at(`/${ids.high}/triage`), {
      route: 'issue',
      createIssue: { complexity: 's' },
    });
    expect([res.status, res.json.error.code]).toEqual([403, 'PERMISSION_FORBIDDEN']);
  });

  it('files the carrier issue with the bands the triage names', async () => {
    ok(
      await say('owner', 'POST', at(`/${ids.high}/triage`), {
        route: 'issue',
        createIssue: { complexity: 's', category: 'bug', priority: 'high' },
      }),
    );
    const read = ok(await say('owner', 'GET', at(`/${ids.high}`))).feedback;
    expect(read.phase).toBe('planned');
    ids.carrierKey = read.route.key;
    expect(ids.carrierKey).toMatch(/^ISS-\d+$/);
    const carrier = ok(
      await say('owner', 'GET', `/api/issues/${ids.carrierKey}?projectId=${projectId}`),
    );
    expect(carrier).toMatchObject({ complexity: 's', category: 'bug', priority: 'high' });
    ids.carrier = carrier.id;
    expect(await standingAs('member', ids.high)).toEqual({
      attentionGroup: 'moving',
      waitingOn: expect.objectContaining({ kind: 'issue', act: 'ship', ref: ids.carrierKey }),
    });
  });
});

describe('a carrier at the release gate waits on whoever makes that release', () => {
  it('names a project writer to release it by hand where no release model is declared', async () => {
    await seedIssueStatus(ids.carrier, 'awaiting_release');
    const act = `release ${ids.carrierKey} by hand and close it`;
    expect(await standingAs('member', ids.high)).toEqual({
      attentionGroup: 'needs_you',
      waitingOn: expect.objectContaining({ kind: 'you', who: 'You', act }),
    });
    expect(await standingAs('viewer', ids.high)).toEqual({
      attentionGroup: 'moving',
      waitingOn: expect.objectContaining({ kind: 'person', who: 'A project writer', act }),
    });
  });
});
