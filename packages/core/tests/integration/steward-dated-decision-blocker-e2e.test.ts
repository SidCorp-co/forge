// ISS-804 (FB-396, REQ-48 BC-5): a dated decision on a dependent answers the steward's ask until its
// date. ISS-6 carried a decision dated until 2026-10-31 answering the ask about its blockers; minutes
// later its blocker ISS-4 went open → in_progress, the dependent's basis named the blocker's new act,
// and the steward asked the master again (as it had on ISS-2..ISS-5 while ISS-1 moved). Here the
// blocker moving inside its run asks nothing, while the date passing, the blocker settling and a new
// blocker drawn after the decision each ask again. An undated decision keeps the standing as its
// bound. Driven through the real app, outbox and steward runtime on a throwaway Postgres, the gateway
// a scripted provider and the standing read a scripted one, as steward-ask-answered-e2e does.
//
// @direct-test-of packages/core/src/steward/asks.ts
// @direct-test-of packages/core/src/steward/standing-question.ts
// @direct-test-of packages/core/src/issues/blocked-by.ts

import type { Said } from '@forge/contracts/said';
import {
  basisFieldsOf,
  type ItemStanding,
  STEWARD_DEBOUNCE_MS,
  standingBasisOf,
} from '@forge/contracts/steward';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
  createTestIssue,
  createTestProject,
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
type Item = { id: string; key: string };
type BlockerAct = 'notStarted' | 'running' | 'paused' | 'cameBack';

let steward: Steward;
let say: (who: 'owner' | 'master', method: string, path: string, body?: unknown) => Promise<Reply>;
let exec: (q: ReturnType<typeof sql>) => Promise<unknown>;
let projectId = '';
let ownerId = '';
let standings: ItemStanding[] = [];
let clock = Date.now();
let seq = 800;

const said = (key: string) => ({ key }) as unknown as Said;
const SINCE = '2026-10-15T00:00:00.000Z';

async function issue(status = 'open'): Promise<Item> {
  seq += 1;
  const made = await createTestIssue(projectId, ownerId, seq, { status, createdAt: new Date() });
  return { id: made.id, key: made.key };
}

/** A live `blocks` edge from `blocker` onto `dependent`, drawn now. */
const draw = (blocker: Item, dependent: Item) =>
  exec(sql`INSERT INTO issue_dependencies (project_id, from_issue_id, to_issue_id, kind)
           VALUES (${projectId}, ${blocker.id}, ${dependent.id}, 'blocks')`);

/** The standing of a set of fields, its basis taken the way the real read takes it. */
function standing(
  item: Item,
  turn: Pick<ItemStanding, 'group' | 'waitingOn' | 'stuck' | 'dueAt' | 'actClass'>,
): ItemStanding {
  const basis = standingBasisOf(basisFieldsOf({ ...turn, carriedBy: null }));
  return {
    subject: { kind: 'issue', id: item.id, key: item.key },
    title: item.key,
    note: null,
    since: SINCE,
    carriedBy: null,
    basis,
    ...turn,
  };
}

/** A dependent's standing behind a live blocker, worded by the blocker's act as `blockerTurn` does. */
const behind = (dependent: Item, blocker: Item, act: BlockerAct) =>
  standing(dependent, {
    group: 'stuck',
    actClass: 'run',
    dueAt: null,
    waitingOn: {
      kind: 'issue',
      who: blocker.key,
      act,
      rule: `blocked by ${blocker.key}`,
      ref: blocker.key,
      dueAt: null,
      says: {
        who: said('standing.who.named'),
        act: said(`issues.standing.act.${act}`),
        rule: said('issues.rule.blocked'),
      },
    },
    stuck: {
      code: 'blocked',
      since: SINCE,
      reason: `${dependent.key} is blocked`,
      via: null,
      says: { reason: said('standing.stuck.blocked') },
    },
  });

/** The dependent's standing once nothing holds it: the master takes it, overdue. */
const masterTakes = (dependent: Item) =>
  standing(dependent, {
    group: 'stuck',
    actClass: 'master_take',
    dueAt: '2026-10-16T00:00:00.000Z',
    waitingOn: {
      kind: 'master',
      who: 'Master',
      act: 'take it',
      rule: 'open',
      ref: null,
      dueAt: null,
      says: {
        who: said('standing.who.master'),
        act: said('standing.act.take'),
        rule: said('rule'),
      },
    },
    stuck: {
      code: 'overdue',
      since: '2026-10-16T00:00:00.000Z',
      reason: `${dependent.key} is overdue`,
      via: null,
      says: { reason: said('overdue') },
    },
  });

/**
 * One steward run on the dependent's standing now, its turn asking the master about it: raised by the
 * sweep where the standing reads on a basis no diagnosis holds, else by the stuck event a retry makes.
 */
async function askRun(on: Item, raise: 'sweep' | 'event' = 'sweep') {
  clock += STEWARD_DEBOUNCE_MS * 10;
  if (raise === 'sweep') {
    await steward.sweepStandings(new Date(clock));
  } else {
    const { db } = await import('../../src/db/client.js');
    const { emitEvent } = await import('../../src/outbox/index.js');
    const row = standings.find((s) => s.subject.id === on.id) as ItemStanding;
    await db.transaction((tx) =>
      emitEvent(tx, 'standing.stuck', {
        projectId,
        subject: row.subject,
        basis: row.basis,
        code: row.stuck?.code ?? 'blocked',
      }),
    );
  }
  await settleOutbox();
  resetScript();
  script.steps = [
    {
      tool: {
        name: 'steward_wake_master',
        args: { about: on.key, ask: `Take the act ${on.key} waits on, or say why it waits.` },
      },
    },
    { text: 'Asked the master.' },
  ];
  clock += STEWARD_DEBOUNCE_MS + 30_000;
  await steward.dispatchStewardRuns(new Date(clock));
}

/** Every ask of the master ever written about `key`, settled or not. */
const asksAbout = (key: string) =>
  rows<{ id: string }>(sql`
    SELECT id FROM steward_acts WHERE project_id = ${projectId} AND master_ask LIKE ${`${key}: %`}`);

/** The master's `decision` record on the dependent, `until` its date where one is given. */
const decide = (item: Item, until?: string) =>
  say('master', 'POST', `/api/issues/${item.id}/events`, {
    kind: 'decision',
    contract: 1,
    fields: [
      { key: 'decision', value: 'It waits on its blockers.' },
      { key: 'why', value: 'Nothing here can start before its blockers land.' },
      ...(until ? [{ key: 'until', value: until }] : []),
    ],
  });

const lastTurn = () => JSON.stringify(script.sent.at(-1));

/** A blocker and its dependent, the dependent asked about once and the ask answered by a decision. */
async function answeredPair(until?: string) {
  const blocker = await issue();
  const dependent = await issue();
  await draw(blocker, dependent);
  standings = [behind(dependent, blocker, 'notStarted')];
  await askRun(dependent);
  expect(await asksAbout(dependent.key)).toHaveLength(1);
  ok(await decide(dependent, until), 201);
  clock += 60_000;
  expect((await steward.sweepStandings(new Date(clock))).settledAsks).toBe(1);
  return { blocker, dependent };
}

/** A date a week from now, so it holds through the test and the clock can be carried past it. */
const nextWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');

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
  const { db } = await import('../../src/db/client.js');
  exec = (q) => db.execute(q);
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
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
}, 120_000);

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await closeWorld();
});

describe("a dated decision on a dependent stands while its blocker moves inside its run (ISS-6's shape)", () => {
  let pair: { blocker: Item; dependent: Item };
  let until = '';

  it('asks nothing when the blocker goes open → in_progress, and the turn is told the date', async () => {
    until = nextWeek();
    pair = await answeredPair(until);
    const { blocker, dependent } = pair;
    // the scripted standing read carries the blocker's move: the dependent's wait names it running
    standings = [behind(dependent, blocker, 'running')];
    await askRun(dependent);
    expect(lastTurn()).toContain('a decision answered it');
    expect(lastTurn()).toContain(`Ask nothing before ${new Date(until).toISOString()}`);
    expect(await asksAbout(dependent.key)).toHaveLength(1);
  });

  it('asks nothing as the blocker pauses and comes back either', async () => {
    const { blocker, dependent } = pair;
    for (const act of ['paused', 'cameBack', 'running'] as const) {
      standings = [behind(dependent, blocker, act)];
      await askRun(dependent);
    }
    expect(await asksAbout(dependent.key)).toHaveLength(1);
  });

  it('asks again once the date has passed (boundary)', async () => {
    const { dependent } = pair;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.parse(until) + 60_000));
    await askRun(dependent, 'event');
    vi.useRealTimers();
    expect(await asksAbout(dependent.key)).toHaveLength(2);
    standings = [];
  });
});

describe('what still voids it: the question changing', () => {
  it('the blocker settling, the dependent now the master to take, asks again', async () => {
    const { dependent } = await answeredPair(nextWeek());
    // the blocker reached a settled status: nothing holds the dependent, the master takes it
    standings = [masterTakes(dependent)];
    await askRun(dependent);
    expect(await asksAbout(dependent.key)).toHaveLength(2);
    standings = [];
  });

  it('a blocker drawn onto the dependent after the decision asks again, its first blocker unmoved', async () => {
    const { blocker, dependent } = await answeredPair(nextWeek());
    await askRun(dependent, 'event');
    expect(await asksAbout(dependent.key)).toHaveLength(1);
    await draw(await issue(), dependent);
    await askRun(dependent, 'event');
    expect(await asksAbout(dependent.key)).toHaveLength(2);
    expect(standings[0]?.waitingOn.ref).toBe(blocker.key);
    standings = [];
  });

  it('a blocker drawn before the decision is the question it answered (negative)', async () => {
    const { dependent } = await answeredPair(nextWeek());
    await askRun(dependent, 'event');
    expect(await asksAbout(dependent.key)).toHaveLength(1);
    standings = [];
  });

  it('an undated decision keeps its standing as its bound: the blocker moving asks again', async () => {
    const { blocker, dependent } = await answeredPair();
    standings = [behind(dependent, blocker, 'running')];
    await askRun(dependent);
    expect(await asksAbout(dependent.key)).toHaveLength(2);
    standings = [];
  });
});
