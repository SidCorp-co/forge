// ISS-1044 (adminhub-api, 2026-11-06): a steward note written before core reworded the facts it
// states stood until the item's basis moved, so at 10:32Z about twelve awaiting_release notes still
// said "lacks counting verdicts on stg" after ISS-1035 and ISS-1040 had landed; and at 10:33:41Z the
// steward asked the master "ISS-192: Complete and settle ISS-191's current test step so its blocking
// edge is cleared" while ISS-191 had been at awaiting_release since 10:30Z and ISS-192 waited on the
// master to dispatch a run. Here a note written under facts core has since reworded (every note
// written before a note recorded its facts at all) reads stale and is re-diagnosed by the next sweep,
// within the sweep's share and oldest first, and only once; and an ask raised on a standing that
// moved under the run, or seeded by a stale note's premise, is never made. Driven through the real
// app, outbox, sweep, dispatch and wake door on a throwaway Postgres: the notes' project through
// lane A's real standing read, the ISS-192 project through a scripted one, the gateway scripted.
//
// @direct-test-of packages/core/src/steward/sweep.ts
// @direct-test-of packages/core/src/steward/dispatch.ts
// @direct-test-of packages/core/src/steward/door-wake.ts
// @direct-test-of packages/core/src/steward/prompts.ts
// @direct-test-of packages/core/src/steward-notes/store.ts

import type { Said } from '@forge/contracts/said';
import {
  basisFieldsOf,
  claimsOf,
  type ItemStanding,
  STEWARD_DEBOUNCE_MS,
  type StewardNote,
  standingBasisOf,
} from '@forge/contracts/steward';
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
let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let realStandings: (projectId: string) => Promise<ItemStanding[]>;
let ownerId = '';
let scriptedProject = '';
/** The scripted project's standing reads, one per call, then `scripted` for every read after. */
let reads: ItemStanding[][] = [];
let scripted: ItemStanding[] = [];
let clock = Date.now();
let seq = 1000;

const said = (key: string) => ({ key }) as unknown as Said;
/** The real sweep over one project, so another test's project spends nothing here. */
const sweep = (projectId: string, now: Date) =>
  steward.sweepProjectStandings(projectId, now, {
    projects: 0,
    stuck: 0,
    changed: 0,
    settledAsks: 0,
    checks: 0,
    paced: 0,
  });

/** A run a test left queued is never taken up by the next test's dispatch. */
const dropQueued = (projectId: string) =>
  rows(sql`DELETE FROM steward_runs WHERE project_id = ${projectId} AND state = 'queued'`);

const later = (from: Date) => new Date(from.getTime() + STEWARD_DEBOUNCE_MS + 30_000);

/** A requirement drafted on `projectId`, read through the real standing read. */
async function requirement(projectId: string, title: string): Promise<ItemStanding> {
  const key = ok(
    await say('owner', 'POST', `/api/projects/${projectId}/requirements`, {
      title,
      reason: 'the rule it states',
      criteria: [{ body: 'A ward list reads by floor.' }],
    }),
    201,
  ).key as string;
  const read = (await realStandings(projectId)).find((s) => s.subject.key === key);
  expect(read).toBeDefined();
  return read as ItemStanding;
}

/**
 * A note on the standing as it reads now, inserted as every note written before ISS-1044 stands:
 * agreeing with its basis, and recording no facts it was written under.
 */
async function noteWrittenBefore(projectId: string, read: ItemStanding, writtenAt: Date) {
  const cites = JSON.stringify([{ kind: 'requirement', ref: read.subject.key }]);
  const claims = JSON.stringify(claimsOf(basisFieldsOf(read)));
  await rows(sql`
    INSERT INTO steward_notes (project_id, subject_kind, subject_id, lines, cites, claims, basis, written_by, written_at)
    VALUES (${projectId}, 'requirement', ${read.subject.id},
            ARRAY[${`${read.subject.key} lacks counting verdicts on stg.`}, 'Next: cut and approve the production release.']::text[],
            ${cites}::jsonb, ${claims}::jsonb, ${read.basis}, ${ownerId}, ${writtenAt.toISOString()})`);
}

const noteRunsOf = (subjectId: string) =>
  rows<{ id: string; state: string }>(sql`
    SELECT id, state FROM steward_runs WHERE subject_id = ${subjectId} AND 'note' = ANY(acts_to_run)
     ORDER BY queued_at`);

/** The items the sweep emitted `standing.changed` for on `projectId`, as the outbox holds them. */
const changedOn = async (projectId: string) =>
  (
    await rows<{ key: string }>(sql`
      SELECT payload -> 'subject' ->> 'key' AS key FROM pipeline_outbox
       WHERE payload ->> 'projectId' = ${projectId} AND type = 'standing.changed'`)
  ).map((r) => r.key);

const noteOf = async (projectId: string, subjectId: string): Promise<StewardNote | null> =>
  (await realStandings(projectId)).find((s) => s.subject.id === subjectId)?.note ?? null;

/** Leave the sweep's share of today room for exactly `room` more runs on `projectId`. */
async function leaveRoom(projectId: string, filler: Item, room: number) {
  const { spentSince, sweepQueued } = await import('../../src/steward/runs-store.js');
  const { sharesOf, stewardStanceOf, utcDayStart } = await import('../../src/steward/policy.js');
  const now = new Date();
  const share = sharesOf((await stewardStanceOf(projectId)).budget).sweep.gatewayTurns;
  const used =
    (await spentSince(projectId, utcDayStart(now), { sweepOnly: true })).gatewayTurns +
    (await sweepQueued(projectId, now)).gatewayTurns;
  await rows(sql`
    INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                              state, turns, not_before, started_at, ended_at)
    VALUES (${projectId}, 'issue', ${filler.id}, ${filler.key}, 'standing.changed', '[]'::jsonb,
            ARRAY['note']::text[], 'done', ${share - used - room}, now(), now(), now())`);
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  const standing = await import('../../src/standing/index.js');
  realStandings = standing.openStandings;
  const { provideStewardStandings } = await import('../../src/steward/index.js');
  provideStewardStandings(async (pid) =>
    pid === scriptedProject ? (reads.shift() ?? scripted) : realStandings(pid),
  );
  await startQueue();
  steward = {
    ...(await import('../../src/steward/dispatch.js')),
    ...(await import('../../src/steward/sweep.js')),
  } as Steward;
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  say = requester(app, { owner: await signUserToken(ownerId) });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a note written under facts core has since reworded is re-diagnosed (ISS-1044 outcome 1)', () => {
  it('reads stale, and the next sweep raises its note run though its basis never moved', async () => {
    const projectId = (await createTestProject(ownerId)).id;
    const read = await requirement(projectId, 'Ward lists read by floor');
    await noteWrittenBefore(projectId, read, new Date(Date.now() - 86_400_000));
    // its basis agrees with the standing: only the facts it was written under have moved
    const before = await noteOf(projectId, read.subject.id);
    expect(before?.basis).toBe(read.basis);
    expect(before?.stale).toBe(true);
    await sweep(projectId, new Date());
    expect(await changedOn(projectId)).toEqual([read.subject.key]);
    await settleOutbox();
    expect(await noteRunsOf(read.subject.id)).toHaveLength(1);
    await dropQueued(projectId);
  });

  it('is rewritten by that run, and the note it writes is current and raises nothing more', async () => {
    const projectId = (await createTestProject(ownerId)).id;
    const read = await requirement(projectId, 'Discharge letters in large type');
    await noteWrittenBefore(projectId, read, new Date(Date.now() - 86_400_000));
    const t0 = new Date();
    await sweep(projectId, t0);
    await settleOutbox();
    resetScript();
    const lines = [`${read.subject.key} is a draft its author has not finished.`];
    script.steps = [
      { tool: { name: 'steward_write_note', args: { lines } } },
      { text: 'Wrote the note.' },
    ];
    await steward.dispatchStewardRuns(later(t0));
    const runs = await noteRunsOf(read.subject.id);
    expect(runs.map((r) => r.state)).toEqual(['done']);
    const after = await noteOf(projectId, read.subject.id);
    expect(after).toMatchObject({ lines, stale: false, basis: read.basis });
    // the business rule's other half: a current note asks for nothing on the next sweep
    await sweep(projectId, later(later(t0)));
    expect(await noteRunsOf(read.subject.id)).toHaveLength(1);
  });

  it('is raised once: a run on it that wrote nothing is not raised again on the same basis (negative)', async () => {
    const projectId = (await createTestProject(ownerId)).id;
    const read = await requirement(projectId, 'Ward boards show the shift lead');
    await noteWrittenBefore(projectId, read, new Date(Date.now() - 86_400_000));
    const t0 = new Date();
    await sweep(projectId, t0);
    await settleOutbox();
    resetScript();
    script.steps = [{ text: 'Nothing to write.' }];
    await steward.dispatchStewardRuns(later(t0));
    expect((await noteRunsOf(read.subject.id)).map((r) => r.state)).toEqual(['done']);
    await sweep(projectId, later(later(t0)));
    expect(await noteRunsOf(read.subject.id)).toHaveLength(1);
  });

  it("spends only the sweep's share, the oldest note first (boundary)", async () => {
    const projectId = (await createTestProject(ownerId)).id;
    const filler = await createTestIssue(projectId, ownerId, 1, {
      status: 'dropped',
      createdAt: new Date(),
    });
    const newer = await requirement(projectId, 'Night rounds list the nurse');
    const older = await requirement(projectId, 'Ward rounds list the doctor');
    await noteWrittenBefore(projectId, newer, new Date(Date.now() - 3_600_000));
    await noteWrittenBefore(projectId, older, new Date(Date.now() - 3 * 86_400_000));
    await leaveRoom(projectId, filler, 1);
    await sweep(projectId, new Date());
    // room for one: the older note is rewritten today, the newer waits for a later sweep
    expect(await changedOn(projectId)).toEqual([older.subject.key]);
    await settleOutbox();
    await dropQueued(projectId);
  });
});

/** A standing on the scripted project, its basis taken the way the real read takes it. */
function standingOf(
  item: Item,
  turn: Pick<ItemStanding, 'group' | 'waitingOn' | 'stuck' | 'dueAt' | 'actClass'>,
  note: ItemStanding['note'] = null,
): ItemStanding {
  const basis = standingBasisOf(basisFieldsOf({ ...turn, carriedBy: null }));
  return {
    subject: { kind: 'issue', id: item.id, key: item.key },
    title: item.key,
    note,
    since: '2026-11-06T09:00:00.000Z',
    carriedBy: null,
    basis,
    ...turn,
  };
}

/** ISS-192 behind ISS-191, which is still on its test step. */
const behindTest = (dependent: Item, blocker: Item, note: ItemStanding['note'] = null) =>
  standingOf(
    dependent,
    {
      group: 'stuck',
      actClass: 'run',
      dueAt: null,
      waitingOn: {
        kind: 'issue',
        who: blocker.key,
        act: 'test',
        rule: `blocked by ${blocker.key}`,
        ref: blocker.key,
        dueAt: null,
        says: {
          who: said('standing.who.named'),
          act: said('issues.standing.act.running'),
          rule: said('issues.rule.blocked'),
        },
      },
      stuck: {
        code: 'blocked',
        since: '2026-11-06T09:00:00.000Z',
        reason: `${dependent.key} is blocked by ${blocker.key}`,
        via: null,
        says: { reason: said('standing.stuck.blocked') },
      },
    },
    note,
  );

/** ISS-192 once ISS-191 landed: nothing holds it, and the master owes it a run, overdue. */
const masterDispatches = (dependent: Item, note: ItemStanding['note'] = null) =>
  standingOf(
    dependent,
    {
      group: 'stuck',
      actClass: 'master_take',
      dueAt: '2026-11-06T10:00:00.000Z',
      waitingOn: {
        kind: 'master',
        who: 'Master',
        act: 'dispatch a run',
        rule: 'open',
        ref: null,
        dueAt: null,
        says: {
          who: said('standing.who.master'),
          act: said('standing.act.dispatch'),
          rule: said('rule'),
        },
      },
      stuck: {
        code: 'overdue',
        since: '2026-11-06T10:30:00.000Z',
        reason: `${dependent.key} is overdue`,
        via: null,
        says: { reason: said('overdue') },
      },
    },
    note,
  );

/** The note ISS-192 still carried at 10:33Z: written while ISS-191 was on its test step. */
const STALE_LINE = 'ISS-192 bị chặn vì ISS-191 còn đang chạy bước kiểm tra';
function staleNote(on: ItemStanding, stale: boolean): StewardNote {
  return {
    subject: { kind: 'issue', id: on.subject.id, key: on.subject.key },
    lines: [STALE_LINE, 'Next: ISS-191 settles its test step.'],
    cites: [{ kind: 'issue', ref: on.subject.key }],
    claims: claimsOf(basisFieldsOf(on)),
    basis: on.basis,
    stale,
    writtenAt: '2026-11-06T09:30:00.000Z',
    writtenBy: { id: ownerId, name: 'steward', kind: 'agent' },
    factsVersion: null,
    runId: null,
  };
}

/** The stale premise the 10:33:41Z ask restated. */
const STALE_ASK = (blocker: Item) =>
  `Complete and settle ${blocker.key}'s current test step so its blocking edge is cleared.`;

/** Every ask of the master about `key`, as the master's nudge would list it. */
const masterAsksAbout = (key: string) =>
  rows<{ master_ask: string }>(sql`
    SELECT master_ask FROM steward_acts WHERE project_id = ${scriptedProject} AND master_ask LIKE ${`${key}: %`}`);

/** A stuck diagnosis of `on`, raised on the basis `raisedOn` reads, its turn scripted as `steps`. */
async function diagnose(on: ItemStanding, steps: typeof script.steps) {
  const { db } = await import('../../src/db/client.js');
  const { emitEvent } = await import('../../src/outbox/index.js');
  clock += STEWARD_DEBOUNCE_MS * 10;
  await db.transaction((tx) =>
    emitEvent(tx, 'standing.stuck', {
      projectId: scriptedProject,
      subject: on.subject,
      basis: on.basis,
      code: on.stuck?.code ?? 'blocked',
    }),
  );
  await settleOutbox();
  resetScript();
  script.steps = steps;
  clock += STEWARD_DEBOUNCE_MS + 30_000;
  await steward.dispatchStewardRuns(new Date(clock));
}

describe("an ask states the item's live standing, never an earlier note's premise (ISS-1044 outcome 2)", () => {
  let blocker: Item;
  let dependent: Item;

  beforeAll(async () => {
    scriptedProject = (await createTestProject(ownerId)).id;
    const masterId = (await createTestUser({ kind: 'agent' })).id;
    await addProjectMember(scriptedProject, masterId, 'member');
    await bindTestRunner(scriptedProject, await createTestDevice(masterId));
    seq += 1;
    blocker = await createTestIssue(scriptedProject, ownerId, seq, {
      status: 'awaiting_release',
      createdAt: new Date(),
    });
    seq += 1;
    dependent = await createTestIssue(scriptedProject, ownerId, seq, {
      status: 'open',
      createdAt: new Date(),
    });
  });

  it('the ISS-192 shape: the blocker lands under the run, and the ask on its test step is not made', async () => {
    const before = behindTest(dependent, blocker);
    const live = masterDispatches(dependent, staleNote(before, true));
    // the run reads the dependent behind its blocker's test step; by the ask, the blocker has landed
    reads = [[{ ...before, note: staleNote(before, false) }]];
    scripted = [live];
    await diagnose(before, [
      {
        tool: {
          name: 'steward_wake_master',
          args: { about: dependent.key, ask: STALE_ASK(blocker) },
        },
      },
      { text: 'Asked the master.' },
    ]);
    const asks = await masterAsksAbout(dependent.key);
    expect(asks.filter((a) => a.master_ask.includes('test step'))).toEqual([]);
    // the turn is told the standing it now reads, by its own wait, not the one it read at start
    const told = JSON.stringify(script.sent.at(-1));
    expect(told).toContain('moved since this run read it');
    expect(told).toContain('dispatch a run');
    reads = [];
    scripted = [];
  });

  it("a stale note's lines never reach the run that reads the item's live standing", async () => {
    const before = behindTest(dependent, blocker);
    const live = masterDispatches(dependent, staleNote(before, true));
    reads = [];
    scripted = [live];
    await diagnose(live, [{ text: 'Read it.' }]);
    const context = JSON.stringify(script.sent[0]);
    expect(context).toContain('dispatch a run');
    expect(context).not.toContain(STALE_LINE);
    scripted = [];
  });

  it("a current note's lines still reach it (negative)", async () => {
    const live = masterDispatches(dependent);
    const current = {
      ...live,
      note: { ...staleNote(live, false), lines: ['ISS-192 waits on its run.'] },
    };
    scripted = [current];
    await diagnose(current, [{ text: 'Read it.' }]);
    expect(JSON.stringify(script.sent[0])).toContain('ISS-192 waits on its run.');
    scripted = [];
  });
});
