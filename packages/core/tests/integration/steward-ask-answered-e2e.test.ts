// ISS-739 (FB-338, REQ-48 BC-5): the steward's ask of the master leaves what the master is owed once
// a dated decision answers it, at the door of the item it names or of the item whose run asked, and a
// wait a person owes is never asked of the master. On dev.355 an ask stood in the master's nudge until
// the 5-minute sweep settled it, so every nudge in between asked again (ISS-688, REQ-67, REQ-65, REQ-36
// at 00:31Z and 00:33Z); a decision on the stuck ISS-748 left the ask about its blocker ISS-746
// standing; and an item waiting on a person (a park the orchestrator owes) was asked of the master.
// Driven through the real app, outbox and steward runtime on a throwaway Postgres, the gateway a
// scripted provider and the standing read a scripted one, as steward-subject-decision-e2e does.
//
// @direct-test-of packages/core/src/steward/asks.ts
// @direct-test-of packages/core/src/steward/sweep.ts
// @direct-test-of packages/core/src/steward/ask-addressee.ts
// @direct-test-of packages/core/src/steward/door-wake.ts
// @direct-test-of packages/core/src/masters/owed.ts

import type { Said } from '@forge/contracts/said';
import type { WaitingKind } from '@forge/contracts/standing';
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

let steward: Steward;
let nudge: () => Promise<string>;
let say: (who: 'owner' | 'master', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let standings: ItemStanding[] = [];
let clock = Date.now();
let seq = 700;

/** A sentence the fake read carries, by its registry key; nothing here renders it. */
const said = (key: string) => ({ key }) as unknown as Said;

/** An open issue of the project. */
async function issue(): Promise<Item> {
  seq += 1;
  const made = await createTestIssue(projectId, ownerId, seq, {
    status: 'open',
    createdAt: new Date(),
  });
  return { id: made.id, key: made.key };
}

/** An issue's standing: waiting on `kind`, stuck overdue unless `stuck` is false. */
function standingOf(
  item: Item,
  basis: string,
  wait: { kind: WaitingKind; who: string; act: string; ref?: string },
  stuck = true,
): ItemStanding {
  return {
    subject: { kind: 'issue', id: item.id, key: item.key },
    title: item.key,
    group: stuck ? 'stuck' : 'moving',
    waitingOn: {
      kind: wait.kind,
      who: wait.who,
      act: wait.act,
      rule: 'the rule the read names',
      ref: wait.ref ?? null,
      dueAt: null,
      says: { who: said('standing.who.named'), act: said('standing.act'), rule: said('rule') },
    },
    note: null,
    actClass: 'master',
    since: '2026-10-15T00:00:00.000Z',
    dueAt: '2026-10-19T00:00:00.000Z',
    stuck: stuck
      ? {
          code: 'overdue',
          since: '2026-10-19T00:00:00.000Z',
          reason: `${item.key} is overdue`,
          via: null,
          says: { reason: said('overdue') },
        }
      : null,
    carriedBy: null,
    basis,
  } as ItemStanding;
}

/** One steward run on `on`'s standing now, its turn asking the master about `about`. */
async function askRun(on: Item, about: Item, emitFirst: 'sweep' | 'event' = 'sweep') {
  clock += STEWARD_DEBOUNCE_MS * 10;
  if (emitFirst === 'sweep') {
    await steward.sweepStandings(new Date(clock));
  } else {
    // a stuck event on a basis already diagnosed: the repeat a failed run's retry makes
    const { db } = await import('../../src/db/client.js');
    const { emitEvent } = await import('../../src/outbox/index.js');
    const row = standings.find((s) => s.subject.id === on.id) as ItemStanding;
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
        args: { about: about.key, ask: `Take the act ${about.key} waits on.` },
      },
    },
    { text: 'Asked the master.' },
  ];
  clock += STEWARD_DEBOUNCE_MS + 30_000;
  await steward.dispatchStewardRuns(new Date(clock));
}

const openAbout = async (key: string) =>
  (await steward.openStewardAsks(projectId)).filter((a) => a.ask.startsWith(`${key}:`));

/** Every ask of the master ever written about `key`, settled or not. */
const masterAsksAbout = (key: string) =>
  rows<{ id: string; settled: string | null }>(sql`
    SELECT id, ask_settled_at AS settled FROM steward_acts
     WHERE project_id = ${projectId} AND master_ask LIKE ${`${key}: %`}`);

const sweep = async () => {
  clock += 60_000;
  return steward.sweepStandings(new Date(clock));
};

/** The master's `decision` record on an issue, `until` its ISO date where one is given. */
const decide = (item: Item, until?: string) =>
  say('master', 'POST', `/api/issues/${item.id}/events`, {
    kind: 'decision',
    contract: 1,
    fields: [
      { key: 'decision', value: 'Not now: it waits on its release.' },
      { key: 'why', value: 'The build that carries it is not served yet.' },
      ...(until ? [{ key: 'until', value: until }] : []),
    ],
  });

/** What the steward's last turn was told, as one string. */
const lastTurn = () => JSON.stringify(script.sent.at(-1));

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
  // the project's master: a box serving it, its credential held by an agent member
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

const MASTER_WAIT = { kind: 'master' as const, who: 'Master', act: 'judge it again' };

describe('a dated decision answers the ask until its date (c1)', () => {
  let item: Item;

  it('leaves the nudge the moment it is recorded, before any sweep settles it', async () => {
    item = await issue();
    standings = [standingOf(item, 'c1-1', MASTER_WAIT)];
    await askRun(item, item);
    expect(await openAbout(item.key)).toHaveLength(1);
    expect(await nudge()).toContain(`${item.key}: Take the act`);
    ok(await decide(item, '2099-01-01'), 201);
    // no sweep between: dev.355 listed it here until the 5-minute sweep came round
    expect(await openAbout(item.key)).toEqual([]);
    expect(await nudge()).not.toContain(`${item.key}: Take the act`);
  });

  it('is settled by the next sweep, and the steward asks nothing more on that standing', async () => {
    expect((await sweep()).settledAsks).toBe(1);
    await askRun(item, item, 'event');
    expect(lastTurn()).toContain('a decision answered it');
    expect(await masterAsksAbout(item.key)).toHaveLength(1);
    expect(await openAbout(item.key)).toEqual([]);
  });

  it('a decision whose date has passed answers nothing, and the ask stays (boundary)', async () => {
    const late = await issue();
    standings = [standingOf(late, 'c1-2', MASTER_WAIT)];
    await askRun(late, late);
    ok(await decide(late, '2020-01-01'), 201);
    expect(await openAbout(late.key)).toHaveLength(1);
    expect((await sweep()).settledAsks).toBe(0);
    expect(await nudge()).toContain(`${late.key}: Take the act`);
    standings = [];
  });
});

describe('a decision on the stuck item or on the blocker it asks about clears the ask (c2)', () => {
  let blocker: Item;
  let stuck: Item;

  const blockedWait = (b: Item) => ({ kind: 'issue' as const, who: b.key, act: 'running', ref: b.key });

  it("names both items' doors in the nudge, the blocker asked about and the stuck item whose run asked", async () => {
    blocker = await issue();
    stuck = await issue();
    standings = [
      standingOf(blocker, 'c2-blocker', { kind: 'run', who: 'Run', act: 'Triage · 5 min' }, false),
      standingOf(stuck, 'c2-stuck', blockedWait(blocker)),
    ];
    await askRun(stuck, blocker);
    expect(await openAbout(blocker.key)).toHaveLength(1);
    const text = await nudge();
    expect(text).toContain(`a decision on ${blocker.key} or ${stuck.key} answers it`);
    expect(text).toContain(`on an issue (${blocker.key}, ${stuck.key})`);
  });

  it('a dated decision on the stuck item, not the one asked about, clears it at once', async () => {
    ok(await decide(stuck, '2099-01-01'), 201);
    expect(await openAbout(blocker.key)).toEqual([]);
    expect((await sweep()).settledAsks).toBe(1);
  });

  it("the stuck item's next run is told its own decision answered the ask about the blocker", async () => {
    await askRun(stuck, blocker, 'event');
    expect(lastTurn()).toContain('a decision answered it');
    expect(await masterAsksAbout(blocker.key)).toHaveLength(1);
  });

  it('a dated decision on the blocker asked about still clears it (the other half)', async () => {
    const b2 = await issue();
    const s2 = await issue();
    standings = [
      standingOf(b2, 'c2-blocker-2', { kind: 'run', who: 'Run', act: 'Build · 2 min' }, false),
      standingOf(s2, 'c2-stuck-2', blockedWait(b2)),
    ];
    await askRun(s2, b2);
    expect(await openAbout(b2.key)).toHaveLength(1);
    ok(await decide(b2, '2099-01-01'), 201);
    expect(await openAbout(b2.key)).toEqual([]);
    standings = [];
  });
});

describe('a wait a person owes is not asked of the master (c3)', () => {
  const PERSON_WAIT = {
    kind: 'person' as const,
    who: 'orchestrator, qa',
    act: 'make a decision',
  };

  it('asks the master nothing, and the turn is told the person owes it', async () => {
    const parked = await issue();
    standings = [standingOf(parked, 'c3-1', PERSON_WAIT)];
    await askRun(parked, parked);
    expect(await masterAsksAbout(parked.key)).toEqual([]);
    expect(lastTurn()).toContain(
      `${parked.key} waits on orchestrator, qa to make a decision: a person's act`,
    );
    expect(await nudge()).not.toContain(`${parked.key}: Take the act`);
  });

  it('a wait on the master on the same footing is still asked (negative)', async () => {
    const own = await issue();
    standings = [standingOf(own, 'c3-2', MASTER_WAIT)];
    await askRun(own, own);
    expect(await masterAsksAbout(own.key)).toHaveLength(1);
  });

  it('an ask standing from before is settled once its item reads as waiting on a person', async () => {
    const own = standings[0] as ItemStanding;
    const item = { id: own.subject.id, key: own.subject.key };
    expect(await openAbout(item.key)).toHaveLength(1);
    // the same basis, read as a person's wait: an ask the master was sent before this rule held
    standings = [standingOf(item, 'c3-2', PERSON_WAIT)];
    expect((await sweep()).settledAsks).toBe(1);
    expect(await openAbout(item.key)).toEqual([]);
    standings = [];
  });
});
