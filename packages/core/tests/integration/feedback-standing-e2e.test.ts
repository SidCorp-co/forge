/**
 * Whom a feedback item waits on, by who reads it. A new item's triage is placed by the one rule of who
 * owes an act under the project's policy (ISS-1132): the master's outside strict, live or not, so
 * holding feedback.approve puts nothing on a person's Needs you; a strict project keeps it a holder's.
 * The master's sweep lists every item it owes, so one filed while no master was live is recovered
 * when one is. A carrier filed at draft holds the item triaged and stuck until it is taken on (BC-9,
 * draft_carrier).
 *
 * @direct-test-of packages/core/src/feedback/standing.ts
 * @direct-test-of packages/core/src/feedback/standing-carrier.ts
 * @direct-test-of packages/core/src/lib/standing-times.ts
 * @direct-test-of packages/core/src/feedback/owed-triage.ts
 */

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
import { declareControls } from '../helpers/project-controls.js';
import { ROLE_WHO } from '../helpers/role-who.js';
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

type Who = 'owner' | 'member' | 'viewer' | 'box';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let box = '';
let runnerId = '';
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
  ownerId = owner;
  const member = (await createTestUser({ verified: true })).id;
  const viewer = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(owner)).id;
  await addProjectMember(projectId, member, 'member');
  await addProjectMember(projectId, viewer, 'viewer');
  box = await createTestDevice(owner);
  runnerId = await bindTestRunner(projectId, box);
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

/** What core names on the master's pass, read through the box's verdict as the sweep reads it. */
async function masterLine(): Promise<string> {
  const answer = ok(
    await say('box', 'POST', '/api/devices/me/master-session/verdict', {
      projectId,
      runnerId,
      facts: {
        restarting: null,
        terminal: true,
        standing: 'proceed',
        pane: 'absent',
        capability: null,
        serversReadable: true,
        work: { poolWaits: false, jobPanes: 0 },
        conversation: { id: null, transcript: 'absent', elsewhere: 'none' },
        placement: null,
        holding: { kind: 'nothing' },
        turn: { kind: 'ended' },
        idle: {
          noWorkForSeconds: 0,
          pane: null,
          children: { total: 0, unfinished: [], lastClosedAgoSeconds: null },
        },
        limit: { refusal: null, hooks: 'unheard', turnStartedAgoMs: null },
        nudge: { last: null, since: 'unreported' },
      },
    }),
  );
  return answer.work.owedLine as string;
}

/** The feedback keys core names on the master's pass as owed a triage, in the order it names them. */
async function owedTriages(): Promise<string[]> {
  const named = /owes? a triage \(([^)]*)\)/.exec(await masterLine());
  return named?.[1]?.split(', ') ?? [];
}

/** The proposed triages core names on the master's pass as its own to decide. */
async function proposedTriages(): Promise<string[]> {
  const named = /proposed triage that is yours to decide \(([^)]*)\)/.exec(await masterLine());
  return named?.[1]?.split('; ') ?? [];
}

const MASTER_WAIT = expect.objectContaining({
  kind: 'agent',
  who: "The project's master",
  act: 'triage it',
});
const MASTER_TRIAGES = { attentionGroup: 'moving', waitingOn: MASTER_WAIT };
/** With no master serving, the master's act reads stuck on it, never a person's turn. */
const MASTER_ABSENT = { attentionGroup: 'stuck', waitingOn: MASTER_WAIT };

// ISS-1132 (FB-577): planted red, the owner read "You: triage it" on its Needs you for a project
// whose policy gives triage to the master, because no master was live
describe('with no live master on a project that is not strict, an untriaged item is still the master’s', () => {
  it('is on nobody’s Needs you, the holder of feedback.approve’s included, and its filing wakes the bound box', async () => {
    await settleOutbox();
    publish.mockClear();
    ids.low = await file('low', 'The board drops a column on resize');
    for (const who of ['owner', 'member', 'viewer'] as const) {
      expect(await standingAs(who, ids.low), who).toEqual(MASTER_ABSENT);
    }
    expect(await feedbackWakes()).toEqual([
      expect.objectContaining({ room: `device:${box}`, projectId, severity: 'low' }),
    ]);
  });

  it('reads a high item the same', async () => {
    ids.high = await file('high', 'Saving the board loses every card');
    expect(await standingAs('owner', ids.high)).toEqual(MASTER_ABSENT);
  });
});

describe('a strict project keeps a new item’s triage a person’s', () => {
  afterAll(async () => {
    await declareControls(projectId, ownerId, { gates: { profile: 'standard' } });
  });

  it('is the owner’s own act, on their Needs you, and names the permission to those without it', async () => {
    await declareControls(projectId, ownerId, { gates: { profile: 'strict' } });
    expect(await standingAs('owner', ids.low)).toEqual({
      attentionGroup: 'needs_you',
      waitingOn: expect.objectContaining({ kind: 'you', who: 'You', act: 'triage it' }),
    });
    for (const who of ['member', 'viewer'] as const) {
      expect(await standingAs(who, ids.low)).toEqual({
        attentionGroup: 'waiting',
        waitingOn: expect.objectContaining({
          kind: 'person',
          who: 'Feedback triager',
          act: 'triage it',
        }),
      });
    }
  });
});

describe('with a live master, every untriaged item is owed to it, most severe first', () => {
  beforeAll(async () => {
    const { ensureMasterSession } = await import('../../src/devices/master-session.js');
    await ensureMasterSession({ deviceId: box, projectId, name: 'master' });
  });

  it('recovers the items filed while no master heard their wake, and lists a new one between them', async () => {
    await settleOutbox();
    publish.mockClear();
    ids.medium = await file('medium', 'The board forgets its filter on reload');
    expect(await feedbackWakes()).toEqual([
      expect.objectContaining({ room: `device:${box}`, projectId, severity: 'medium' }),
    ]);
    expect(await owedTriages()).toEqual([ids.high, ids.medium, ids.low]);
  });

  it.each(['low', 'medium', 'high'] as const)(
    'reads a %s item as the master’s act, whoever reads it',
    async (severity) => {
      for (const who of ['owner', 'member'] as const) {
        expect(await standingAs(who, ids[severity])).toEqual(MASTER_TRIAGES);
      }
    },
  );

  // ISS-1132: a proposed triage left the item on its holders' Needs you and off the master's pass
  it('keeps an item carrying a proposed triage on the master’s pass, naming the suggestion to decide', async () => {
    const proposed = ok(
      await say('member', 'POST', `/api/projects/${projectId}/suggestions`, {
        kind: 'feedback_triage',
        feedback: ids.medium,
        baseRevision: null,
        payload: { route: 'issue', createIssue: {}, answers: TRIAGE_ANSWERS, note: 'the filter' },
      }),
      201,
    );
    const id = proposed.suggestion.id as string;
    expect(await owedTriages()).toEqual([ids.high, ids.low]);
    expect(await proposedTriages()).toEqual([`${ids.medium} suggestion ${id}`]);
    expect(await standingAs('owner', ids.medium)).toEqual(MASTER_TRIAGES);
    ok(
      await say('owner', 'POST', `/api/projects/${projectId}/suggestions/${id}/reject`, {
        reason: 'Routed by hand instead.',
      }),
    );
    expect(await owedTriages()).toEqual([ids.high, ids.medium, ids.low]);
  });
});

describe('a high item is triaged onto an issue', () => {
  it('refuses a triage from a member who lacks feedback.approve', async () => {
    const res = await say('member', 'POST', at(`/${ids.high}/triage`), {
      answers: TRIAGE_ANSWERS,
      route: 'issue',
      createIssue: { complexity: 's' },
    });
    expect([res.status, res.json.error.code]).toEqual([403, 'PERMISSION_FORBIDDEN']);
  });

  it('files the carrier issue with the bands the triage names', async () => {
    ok(
      await say('owner', 'POST', at(`/${ids.high}/triage`), {
        answers: TRIAGE_ANSWERS,
        route: 'issue',
        createIssue: { complexity: 's', category: 'bug', priority: 'high' },
      }),
    );
    const read = ok(await say('owner', 'GET', at(`/${ids.high}`))).feedback;
    expect(read.phase, 'the carrier is filed at draft, which plans nothing yet').toBe('triaged');
    expect(read.times.stuck).toMatchObject({ code: 'draft_carrier' });
    expect(read.route.carriers).toHaveLength(1);
    ids.carrierKey = read.route.carriers[0].key;
    expect(ids.carrierKey).toMatch(/^ISS-\d+$/);
    const carrier = ok(
      await say('owner', 'GET', `/api/issues/${ids.carrierKey}?projectId=${projectId}`),
    );
    expect(carrier).toMatchObject({ complexity: 's', category: 'bug', priority: 'high' });
    ids.carrier = carrier.id;
    await seedIssueStatus(ids.carrier, 'open');
    expect(ok(await say('owner', 'GET', at(`/${ids.high}`))).feedback.phase).toBe('planned');
    expect(await standingAs('member', ids.high)).toEqual({
      attentionGroup: 'moving',
      waitingOn: expect.objectContaining({ ref: ids.carrierKey }),
    });
  });
});

describe('a carrier at the release gate waits on whoever makes that release', () => {
  it('names the project writers to release it by hand where no release model is declared', async () => {
    await seedIssueStatus(ids.carrier, 'awaiting_release');
    const act = `release ${ids.carrierKey} by hand and close it`;
    // releasing by hand is no decision, but it is the writer's own act: on their Needs you (ISS-924)
    expect(await standingAs('member', ids.high)).toEqual({
      attentionGroup: 'needs_you',
      waitingOn: expect.objectContaining({ kind: 'you', who: 'You', act }),
    });
    expect(await standingAs('viewer', ids.high)).toEqual({
      attentionGroup: 'moving',
      waitingOn: expect.objectContaining({
        kind: 'person',
        who: expect.not.stringMatching(ROLE_WHO),
        act,
      }),
    });
  });
});

// FB-434's shape: a wait on "the master" that nothing can place sits stuck nobody_serves. A project no
// runner is bound to never gets a master, so its new item's triage falls to a holder, named
describe('a project no runner is bound to', () => {
  it('names a holder of feedback.approve for a new item, never a master that cannot come', async () => {
    const { id: unbound } = await createTestProject(ownerId);
    const target = ok(
      await say('owner', 'POST', `/api/projects/${unbound}/issues`, { title: 'The list view' }),
      201,
    ).id;
    const made = ok(
      await say('owner', 'POST', `/api/projects/${unbound}/feedback`, {
        kind: 'bug',
        severity: 'medium',
        title: 'The list loses its sort',
        issue: target,
      }),
      201,
    );
    const list = ok(await say('owner', 'GET', `/api/projects/${unbound}/feedback`));
    const row = list.feedback.find((f: Doc) => f.key === made.feedback.key);
    expect(row).toMatchObject({
      attentionGroup: 'needs_you',
      waitingOn: expect.objectContaining({ kind: 'you', who: 'You', act: 'triage it' }),
    });
    expect(row.waitingOn.rule).toContain('no runner is bound');
  });
});
