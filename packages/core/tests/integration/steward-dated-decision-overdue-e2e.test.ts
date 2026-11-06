// ISS-1037 (FB-534, sidpeak 2026-11-06): REQ-9, REQ-10 and REQ-11 carried decision comments with
// `reversedWhen 2026-11-12`, recorded 2026-11-05T13:13Z while each draft waited on its agreement; the
// next day each read stuck `overdue` on its own clock, and at 07:23Z the steward asked again about all
// eleven requirements, as it had for decisions whose reversedWhen was a condition. Here a dated or a
// conditioned decision recorded while the item waited on an act keeps answering once that same wait
// turns overdue, until its date passes or another act is owed; an undated one keeps its standing as
// its bound. Driven through the real app, outbox, sweep, dispatch and wake door on a throwaway
// Postgres, the gateway a scripted provider and the standing read a scripted one, as
// steward-subject-decision-e2e does.
//
// @direct-test-of packages/core/src/steward/asks.ts
// @direct-test-of packages/core/src/steward/standing-question.ts
// @direct-test-of packages/core/src/comments/decision-answers.ts

import type { Said } from '@forge/contracts/said';
import {
  basisFieldsOf,
  claimsOf,
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
type Item = { id: string; key: string };

let steward: Steward;
let say: (who: 'owner' | 'master', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let standings: ItemStanding[] = [];
let clock = Date.now();
let seq = 0;

const said = (key: string) => ({ key }) as unknown as Said;
const DAY = 86_400_000;
/** When each draft began to wait on the act: two days before the decision is recorded. */
const since = () => new Date(Date.now() - 2 * DAY).toISOString();

/**
 * A draft requirement waiting on the master to propose it for agreement, `actKey` naming the act;
 * `overdue` once its due has passed on its own clock, the standing then reading stuck from `at`.
 */
function waiting(
  item: Item,
  began: string,
  overdue: { at: string } | null = null,
  actKey = 'standing.act.proposeOrDrop',
): ItemStanding {
  const due = new Date(Date.parse(began) + DAY).toISOString();
  const turn = {
    group: overdue ? ('stuck' as const) : ('waiting' as const),
    actClass: 'master_take' as const,
    dueAt: due,
    waitingOn: {
      kind: 'agent' as const,
      who: 'Master',
      act: 'propose it for agreement, or drop it',
      rule: 'an agent drafted it',
      ref: null,
      dueAt: null,
      says: {
        who: said('standing.who.master'),
        act: said(actKey),
        rule: said('requirements.rule.agentDraft'),
      },
    },
    stuck: overdue
      ? {
          code: 'overdue' as const,
          since: overdue.at,
          reason: `${item.key} is overdue`,
          via: null,
          says: { reason: said('standing.stuck.overdue') },
        }
      : null,
  };
  const basis = standingBasisOf(basisFieldsOf({ ...turn, carriedBy: null }));
  return {
    subject: { kind: 'requirement', id: item.id, key: item.key },
    title: item.key,
    // a current note on it, so the sweep raises no note run of its own beside the diagnosis
    note: {
      subject: { kind: 'requirement', id: item.id, key: item.key },
      lines: [`${item.key} waits on the master.`],
      cites: [{ kind: 'requirement', ref: item.key }],
      claims: claimsOf(basisFieldsOf({ ...turn, carriedBy: null })),
      basis,
      stale: false,
      factsVersion: null,
      writtenAt: began,
      writtenBy: { id: ownerId, name: null, kind: 'agent' },
      runId: null,
    },
    since: began,
    carriedBy: null,
    basis,
    ...turn,
  };
}

async function requirement(): Promise<Item> {
  seq += 1;
  return createTestRequirement(projectId, seq, `Ward list ${seq}`);
}

/** One steward run on the item's standing now, its turn asking the master about it. */
async function askRun(on: ItemStanding, raise: 'sweep' | 'event') {
  clock += STEWARD_DEBOUNCE_MS * 10;
  if (raise === 'sweep') {
    await steward.sweepStandings(new Date(clock));
  } else {
    // a run on a standing no sweep raises (it reads waiting, not stuck): the intake check's ask
    const { db } = await import('../../src/db/client.js');
    const { emitEvent } = await import('../../src/outbox/index.js');
    await db.transaction((tx) =>
      emitEvent(tx, 'standing.stuck', {
        projectId,
        subject: on.subject,
        basis: on.basis,
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
        args: {
          about: on.subject.key,
          ask: `Propose ${on.subject.key} for agreement, or drop it.`,
        },
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

/** The asks of the master about `key` still standing: one a decision answered is settled. */
const openAsksAbout = (key: string) =>
  rows<{ id: string }>(sql`
    SELECT id FROM steward_acts WHERE project_id = ${projectId} AND master_ask LIKE ${`${key}: %`}
       AND ask_settled_at IS NULL`);

/** The master's decision comment on the requirement, `reversedWhen` as given. */
const decide = (item: Item, reversedWhen?: string) =>
  say('master', 'POST', `/api/projects/${projectId}/requirements/${item.key}/comments`, {
    intent: 'decision',
    decision: {
      decision: 'Keep it waiting for its agreement.',
      reason: 'The BA who agrees it is not yet a member of the project.',
      ...(reversedWhen ? { reversedWhen } : {}),
    },
  });

const lastTurn = () => JSON.stringify(script.sent.at(-1));

/** A date a week from now, so it holds through the test and the clock can be carried past it. */
const nextWeek = () => new Date(Date.now() + 7 * DAY).toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * The sidpeak sequence up to the re-ask: the draft waits, the master is asked, the master records a
 * decision, the sweep settles the ask, and then the draft turns overdue on its own clock.
 */
async function decidedThenOverdue(reversedWhen?: string) {
  const item = await requirement();
  const began = since();
  const before = waiting(item, began);
  standings = [before];
  await askRun(before, 'event');
  expect(await asksAbout(item.key)).toHaveLength(1);
  ok(await decide(item, reversedWhen), 201);
  clock += 60_000;
  await steward.sweepStandings(new Date(clock));
  expect(await openAsksAbout(item.key)).toHaveLength(0);
  // a day later its due passes: the same wait reads stuck `overdue`, from after the decision
  const overdue = waiting(item, began, { at: new Date(Date.now() + 60_000).toISOString() });
  expect(overdue.basis).not.toBe(before.basis);
  standings = [overdue];
  return { item, began, overdue };
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
  standings = [];
});

afterAll(async () => {
  await closeWorld();
});

describe('a decision recorded while a requirement waited keeps answering once it turns overdue (ISS-1037)', () => {
  it('a dated decision: the sweep diagnoses the overdue draft and nothing is asked (the sidpeak sequence)', async () => {
    const until = nextWeek();
    const { item, overdue } = await decidedThenOverdue(until);
    await askRun(overdue, 'sweep');
    expect(lastTurn()).toContain('a decision answered it');
    expect(lastTurn()).toContain(`Ask nothing before ${new Date(until).toISOString()}`);
    expect(await asksAbout(item.key)).toHaveLength(1);
  });

  it('a conditioned decision answers the same way, until its act is taken', async () => {
    const { item, overdue } = await decidedThenOverdue('until the BA joins the project');
    await askRun(overdue, 'sweep');
    expect(lastTurn()).toContain('a decision answered it');
    expect(await asksAbout(item.key)).toHaveLength(1);
  });

  it('asks again once the date has passed (boundary)', async () => {
    const until = nextWeek();
    const { item, overdue } = await decidedThenOverdue(until);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.parse(until) + 60_000));
    await askRun(overdue, 'event');
    vi.useRealTimers();
    expect(await asksAbout(item.key)).toHaveLength(2);
  });
});

describe('what still voids it (negative)', () => {
  it('another act owed on the item is a question the decision never answered', async () => {
    const { item, began } = await decidedThenOverdue(nextWeek());
    // its author returned it: the master now owes a revision before it proposes, from now
    const returned = waiting(
      item,
      new Date(Date.now() + 60_000).toISOString(),
      { at: new Date(Date.now() + 120_000).toISOString() },
      'standing.act.reviseThenProposeOrDrop',
    );
    expect(returned.since).not.toBe(began);
    standings = [returned];
    await askRun(returned, 'sweep');
    expect(await asksAbout(item.key)).toHaveLength(2);
  });

  it('an undated decision keeps its standing as its bound: the overdue turn asks again', async () => {
    const { item, overdue } = await decidedThenOverdue();
    await askRun(overdue, 'sweep');
    expect(await asksAbout(item.key)).toHaveLength(2);
  });
});
