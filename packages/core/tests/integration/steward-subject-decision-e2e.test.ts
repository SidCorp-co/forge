// ISS-654 (REQ-48 BC-5): the steward's ask of the master about a feedback item or a requirement is
// answered on that item. A steward ask is keyed to its run's subject, an issue, a feedback item or a
// requirement; the master's nudge names, for each, the door that records a decision on it, and the
// steward reads a reasoned decision written there after the ask as its answer, as it does an issue's
// `decision` record (ISS-607). The issue door answers 404 for a feedback item, so a nudge naming it
// for every ask left a feedback or requirement ask with no way to be answered on record.
// Driven through the real app, outbox and steward runtime on a throwaway Postgres, the gateway a
// scripted provider and the standing read a scripted one, as steward-release-ask-e2e does.
//
// @direct-test-of packages/core/src/steward/asks.ts
// @direct-test-of packages/core/src/steward/sweep.ts
// @direct-test-of packages/core/src/masters/owed.ts
// @direct-test-of packages/core/src/comments/decision-answers.ts
// @direct-test-of packages/core/src/comments/entity-routes.ts

import type { Said } from '@forge/contracts/said';
import { type ItemStanding, STEWARD_DEBOUNCE_MS } from '@forge/contracts/steward';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeWorld,
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
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestRequirement,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { resetScript, script } from '../helpers/scripted-chat.js';

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/llm/chat.js')>()),
  openChat: (await import('../helpers/scripted-chat.js')).scriptedOpenChat,
}));

type Steward = typeof import('../../src/steward/dispatch.js') &
  typeof import('../../src/steward/sweep.js');
type Item = { kind: 'issue' | 'feedback' | 'requirement'; id: string; key: string };

let steward: Steward;
let nudge: () => Promise<string>;
let say: (who: 'owner' | 'master', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let standings: ItemStanding[] = [];
let clock = Date.now();

/** A sentence the fake read carries, by its registry key; nothing here renders it. */
const said = (key: string) => ({ key }) as unknown as Said;

/** An item waiting, overdue, on a person who decides: a feedback item's triage, a requirement's agree. */
function personWait(item: Item, basis: string): ItemStanding {
  return {
    subject: { kind: item.kind, id: item.id, key: item.key },
    title: item.key,
    group: 'stuck',
    waitingOn: {
      kind: 'person',
      who: 'A holder of feedback.approve',
      act: 'triage it',
      rule: 'a person decides what happens to it',
      ref: null,
      dueAt: '2026-10-19T00:00:00.000Z',
      says: {
        who: said('standing.who.holderOf'),
        act: said('standing.act.triage'),
        rule: said('feedback.rule.untriaged'),
      },
    },
    note: null,
    actClass: 'person_decide',
    since: '2026-10-15T00:00:00.000Z',
    dueAt: '2026-10-19T00:00:00.000Z',
    stuck: {
      code: 'overdue',
      since: '2026-10-19T00:00:00.000Z',
      reason: `${item.key} is overdue for a person's decision`,
      via: null,
      says: { reason: said('overdue') },
    },
    carriedBy: null,
    basis,
  };
}

/** One steward run on the item's standing now, its turn asking the master about the item. */
async function askRun(item: Item, emitFirst: 'sweep' | 'event' = 'sweep') {
  clock += STEWARD_DEBOUNCE_MS * 10;
  if (emitFirst === 'sweep') {
    await steward.sweepStandings(new Date(clock));
  } else {
    // a stuck event on a basis already diagnosed: the repeat a failed run's retry makes
    const { db } = await import('../../src/db/client.js');
    const { emitEvent } = await import('../../src/outbox/index.js');
    const row = standings.find((s) => s.subject.id === item.id) as ItemStanding;
    await db.transaction((tx) =>
      emitEvent(tx, 'standing.stuck', {
        projectId,
        subject: row.subject,
        basis: row.basis,
        code: 'overdue',
      }),
    );
  }
  await settleOutbox();
  resetScript();
  script.steps = [
    {
      tool: {
        name: 'steward_wake_master',
        args: { about: item.key, ask: `Take the decision ${item.key} waits on.` },
      },
    },
    { text: 'Asked the master.' },
  ];
  clock += STEWARD_DEBOUNCE_MS + 30_000;
  await steward.dispatchStewardRuns(new Date(clock));
}

const openAbout = async (key: string) =>
  (await steward.openStewardAsks(projectId)).filter((a) => a.ask.startsWith(`${key}:`));

const sweep = async () => {
  clock += 60_000;
  return steward.sweepStandings(new Date(clock));
};

/** The decision door of a feedback item or a requirement, as the master writes it. */
const decideOn = (item: Item, decision: Record<string, unknown> | undefined) =>
  say(
    'master',
    'POST',
    `/api/projects/${projectId}/${item.kind === 'feedback' ? 'feedback' : 'requirements'}/${item.key}/comments`,
    decision === undefined ? { intent: 'decision' } : { intent: 'decision', decision },
  );

async function feedbackItem(seq: number): Promise<Item> {
  const key = await createTestFeedback(projectId, ownerId, seq);
  const [row] = await rows<{ id: string }>(
    sql`SELECT id FROM feedback WHERE project_id = ${projectId} AND fb_seq = ${seq}`,
  );
  return { kind: 'feedback', id: row?.id as string, key };
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  const { provideStewardStandings } = await import('../../src/steward/index.js');
  provideStewardStandings(async (pid) => (pid === projectId ? standings : []));
  await startQueue();
  steward = {
    ...(await import('../../src/steward/dispatch.js')),
    ...(await import('../../src/steward/sweep.js')),
  } as Steward;
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  // the project's master: a box serving it, its credential held by an agent member, who may not triage
  const masterId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, masterId, 'member');
  const deviceId = await createTestDevice(masterId);
  await bindTestRunner(projectId, deviceId);
  const { mintPat } = await import('../../src/credentials/pat.js');
  const { deviceTokenNameFor } = await import('../../src/credentials/pat-format.js');
  const pat = await mintPat({
    userId: masterId,
    name: deviceTokenNameFor(deviceId),
    permissions: ['*'],
    deviceId,
  });
  say = requester(app, { owner: await signUserToken(ownerId), master: pat.plaintext });
  const { readMasterWork } = await import('../../src/masters/owed.js');
  nudge = async () => (await readMasterWork(deviceId, projectId)).nudge;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a feedback item waiting on a person: the master records why it waits on the item (c1, c2, c3)', () => {
  let fb: Item;

  it("the master's nudge names the feedback item's decision door, not the issue one (c2)", async () => {
    fb = await feedbackItem(36);
    standings = [personWait(fb, 'fb-1')];
    await askRun(fb);
    expect(await openAbout(fb.key)).toHaveLength(1);
    const text = await nudge();
    expect(text).toContain(
      `on a feedback item (${fb.key}), \`forge-runner api projects/<projectId>/feedback/<key>/comments -X POST\` with \`intent: decision\``,
    );
    expect(text).not.toContain('issues/<id>/events');
  });

  it('the master may not triage it, and the issue door does not serve it', async () => {
    const read = ok(
      await say('master', 'GET', `/api/projects/${projectId}/feedback/${fb.key}`),
      200,
    );
    expect((read as { feedback: { can: { triage: boolean } } }).feedback.can.triage).toBe(false);
    const issueDoor = await say('master', 'POST', `/api/issues/${fb.id}/events`, {
      kind: 'decision',
      contract: 1,
      fields: [
        { key: 'decision', value: 'waits' },
        { key: 'why', value: 'only a feedback.approve holder can triage it' },
      ],
    });
    expect(issueDoor.status).toBe(404);
  });

  it('a decision with no fields is refused by name, and the ask stays (negative)', async () => {
    const wrote = await decideOn(fb, undefined);
    expect(wrote.status).toBe(422);
    expect(JSON.stringify(wrote.json)).toContain('COMMENT_DECISION_REQUIRED');
    expect((await sweep()).settledAsks).toBe(0);
    expect(await openAbout(fb.key)).toHaveLength(1);
  });

  it('a reasoned decision on the feedback item answers its ask (c1)', async () => {
    const wrote = await decideOn(fb, {
      decision: 'waits',
      reason: 'only a holder of feedback.approve can triage it; the master may not',
    });
    ok(wrote, 201);
    expect((wrote.json as { warnings?: string[] }).warnings).toBeUndefined();
    expect((await sweep()).settledAsks).toBe(1);
    expect(await openAbout(fb.key)).toEqual([]);
  });

  it('the steward reads the answer and asks nothing more on the same standing (c3)', async () => {
    await askRun(fb, 'event');
    expect(await openAbout(fb.key)).toEqual([]);
    expect(JSON.stringify(script.sent.at(-1))).toContain('a decision answered it');
  });

  it('a moved standing asks again', async () => {
    standings = [personWait(fb, 'fb-2')];
    await askRun(fb);
    expect(await openAbout(fb.key)).toHaveLength(1);
  });

  it('a reversedWhen that is no date is read as a condition, and the write says so', async () => {
    const wrote = await decideOn(fb, {
      decision: 'waits',
      reason: 'the owner triages it at the next review',
      reversedWhen: 'the owner triages it',
    });
    ok(wrote, 201);
    expect((wrote.json as { warnings?: string[] }).warnings).toEqual([
      expect.stringContaining('DECISION_UNTIL_CONDITION'),
    ]);
    expect((await sweep()).settledAsks).toBe(1);
    expect(await openAbout(fb.key)).toEqual([]);
  });

  it('a reversedWhen date already past answers nothing, and the write says it has passed', async () => {
    standings = [personWait(fb, 'fb-3')];
    await askRun(fb);
    expect(await openAbout(fb.key)).toHaveLength(1);
    const wrote = await decideOn(fb, {
      decision: 'waits',
      reason: 'held for a review that has already passed',
      reversedWhen: '2020-01-01',
    });
    ok(wrote, 201);
    expect((wrote.json as { warnings?: string[] }).warnings).toEqual([
      expect.stringContaining('DECISION_UNTIL_PASSED'),
    ]);
    expect((await sweep()).settledAsks).toBe(0);
    expect(await openAbout(fb.key)).toHaveLength(1);
    standings = [];
  });
});

describe('the same root on a requirement, and an issue as before (boundary)', () => {
  it('a requirement ask names the requirement door and a decision there answers it', async () => {
    const created = await createTestRequirement(projectId, 23, 'A guide corpus');
    const req: Item = { kind: 'requirement', ...created };
    standings = [personWait(req, 'req-1')];
    await askRun(req);
    expect(await openAbout(req.key)).toHaveLength(1);
    const text = await nudge();
    expect(text).toContain(
      `on a requirement (${req.key}), \`forge-runner api projects/<projectId>/requirements/<key>/comments -X POST\``,
    );
    ok(
      await decideOn(req, {
        decision: 'waits',
        reason: 'the overdue decision on its issue is the owner’s',
      }),
      201,
    );
    expect((await sweep()).settledAsks).toBe(1);
    expect(await openAbout(req.key)).toEqual([]);
    standings = [];
  });

  it('an issue ask still names the issue door, and a decision record there answers it', async () => {
    const created = await createTestIssue(projectId, ownerId, 90, {
      status: 'open',
      createdAt: new Date(),
    });
    const issue: Item = { kind: 'issue', id: created.id, key: created.key };
    standings = [personWait(issue, 'iss-1')];
    await askRun(issue);
    expect(await openAbout(issue.key)).toHaveLength(1);
    const text = await nudge();
    expect(text).toContain(
      `on an issue (${issue.key}), \`forge-runner api issues/<id>/events -X POST\` with \`kind: decision\``,
    );
    ok(
      await say('owner', 'POST', `/api/issues/${issue.id}/events`, {
        kind: 'decision',
        contract: 1,
        fields: [
          { key: 'decision', value: 'waits' },
          { key: 'why', value: 'the owner rules on it first' },
        ],
      }),
      201,
    );
    expect((await sweep()).settledAsks).toBe(1);
    expect(await openAbout(issue.key)).toEqual([]);
    standings = [];
  });
});
