// ISS-654 c3 (REQ-48 BC-5): a feedback item waiting on a triage is diagnosed and moved on: the
// steward asks whoever can take the triage, once, with the act it recommends. The ask goes to the
// master where an account it acts as holds feedback.approve, else to the feedback.approve holders by
// name, the steward never among them; where nobody holds it, the item says why. A diagnosis that
// ended on its note alone is finished by Forge asking for it, and one left so by an earlier build is
// diagnosed again, once: live, FB-79 and FB-81 were noted on 2026-10-21 and never asked or run again.
// Driven through the real app, outbox and steward runtime on a throwaway Postgres, the gateway a
// scripted provider and the standing read a scripted one, as steward-release-ask-e2e does.
//
// @direct-test-of packages/core/src/steward/ask-addressee.ts
// @direct-test-of packages/core/src/steward/diagnosis-end.ts
// @direct-test-of packages/core/src/steward/door-wake.ts
// @direct-test-of packages/core/src/steward/runs-store.ts
// @direct-test-of packages/core/src/steward/turn.ts
// @direct-test-of packages/core/src/steward/acts-store.ts
// @direct-test-of packages/core/src/steward-ports.ts
// @direct-test-of packages/core/src/devices/workspace-credential.ts
//
// The master's account is the one its pane writes under (ISS-590 round 2): on a box a person admin
// paired, the agent its pane writes as decides, never that person.

import type { Said } from '@forge/contracts/said';
import { type ItemStanding, STEWARD_DEBOUNCE_MS } from '@forge/contracts/steward';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestFeedback,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { pairTestBox } from '../helpers/paired-box.js';
import { resetScript, type ScriptStep, script } from '../helpers/scripted-chat.js';

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/llm/chat.js')>()),
  openChat: (await import('../helpers/scripted-chat.js')).scriptedOpenChat,
}));

type Steward = typeof import('../../src/steward/dispatch.js') &
  typeof import('../../src/steward/sweep.js');
type Item = { id: string; key: string };

let steward: Steward;
let projectId = '';
let ownerId = '';
let masterId = '';
let deviceId = '';
let standings: ItemStanding[] = [];
let clock = Date.now();

/** A sentence the fake read carries, by its registry key; nothing here renders it. */
const said = (key: string) => ({ key }) as unknown as Said;

/** A feedback item whose carrier was dropped, overdue on a feedback.approve holder to triage it again. */
function triageAgain(item: Item, basis: string): ItemStanding {
  return {
    subject: { kind: 'feedback', id: item.id, key: item.key },
    title: item.key,
    group: 'stuck',
    waitingOn: {
      kind: 'person',
      who: 'a holder of feedback.approve',
      act: 'triage it again',
      rule: 'its carrier was dropped',
      ref: null,
      dueAt: '2026-10-09T00:00:00.000Z',
      says: {
        who: said('standing.who.holderOf'),
        act: said('standing.act.triageAgain'),
        rule: said('feedback.rule.carrierDropped'),
      },
    },
    note: null,
    actClass: 'person_decide',
    since: '2026-10-08T19:02:03.648Z',
    dueAt: '2026-10-09T00:00:00.000Z',
    stuck: {
      code: 'overdue',
      since: '2026-10-08T19:02:03.648Z',
      reason: `${item.key} is overdue to be triaged again`,
      via: null,
      says: { reason: said('overdue') },
    },
    carriedBy: null,
    basis,
  };
}

interface ActRead {
  door: string;
  did: string;
  master_ask: string | null;
}
const actsOn = (id: string) =>
  rows<ActRead>(sql`
    SELECT a.door, a.did, a.master_ask FROM steward_acts a
      JOIN steward_runs r ON r.id = a.run_id
     WHERE r.subject_id = ${id} ORDER BY a.at, a.id`);

const runsOn = (id: string) =>
  rows<{ state: string }>(sql`SELECT state FROM steward_runs WHERE subject_id = ${id}`);

/** Who the steward's notices about the item reached. */
const toldOf = (key: string) =>
  rows<{ user_id: string; title: string }>(sql`
    SELECT dd.user_id, n.title FROM notifications n
      JOIN notification_delivery_members dm ON dm.notification_id = n.id
      JOIN notification_deliveries dd ON dd.id = dm.delivery_id
     WHERE n.type = 'steward_ask' AND n.project_id = ${projectId} AND n.title LIKE ${`${key}:%`}`);

const openAbout = async (key: string) =>
  (await steward.openStewardAsks(projectId)).filter((a) => a.ask.startsWith(`${key}:`));

/**
 * The turn reads the item and ends, moving nothing and asking nobody: what the live runs on FB-79 and
 * FB-81 amounted to, their one act a note. (The note door here reads the item's real standing, not
 * the scripted one, and refuses it stale, so the turn writes none.)
 */
const noteOnly = (_item: Item): ScriptStep[] => [
  { tool: { name: 'steward_read_item', args: {} } },
  { text: 'It waits on a triager; nothing to move.' },
];

/** A sweep over the standings now; what it raised is dispatched with the turn scripted. */
async function sweepAndRun(steps: ScriptStep[]) {
  clock += STEWARD_DEBOUNCE_MS * 10;
  const tally = await steward.sweepStandings(new Date(clock));
  await settleOutbox();
  resetScript();
  script.steps = steps;
  clock += STEWARD_DEBOUNCE_MS + 30_000;
  await steward.dispatchStewardRuns(new Date(clock));
  return tally;
}

let seq = 790;
async function feedbackItem(): Promise<Item> {
  seq += 1;
  const key = await createTestFeedback(projectId, ownerId, seq);
  const [row] = await rows<{ id: string }>(
    sql`SELECT id FROM feedback WHERE project_id = ${projectId} AND fb_seq = ${seq}`,
  );
  return { id: row?.id as string, key };
}

const setMasterGrants = (grants: string[]) =>
  rows(sql`
    UPDATE project_members SET grants = ${sql.raw(`ARRAY[${grants.map((g) => `'${g}'`).join(',')}]::text[]`)}
     WHERE project_id = ${projectId} AND user_id = ${masterId} RETURNING user_id`);

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  const { provideStewardStandings } = await import('../../src/steward/index.js');
  provideStewardStandings(async (pid) => (pid === projectId ? standings : []));
  await startQueue();
  steward = {
    ...(await import('../../src/steward/dispatch.js')),
    ...(await import('../../src/steward/sweep.js')),
  } as Steward;
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  // the project's master: a box paired as an agent member, who may not triage, its pane writing as it
  masterId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, masterId, 'member');
  ({ deviceId } = await pairTestBox(projectId, { pairedBy: masterId, actsAs: masterId }));
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a triage the master may not take is asked of the feedback.approve holders (c3)', () => {
  let fb: Item;

  it('a diagnosis that wrote only the note still asks the holders by name, never the master', async () => {
    fb = await feedbackItem();
    standings = [triageAgain(fb, 'again-1')];
    const tally = await sweepAndRun(noteOnly(fb));
    expect(tally.stuck).toBe(1);
    const acts = await actsOn(fb.id);
    expect(acts.map((a) => [a.door, a.master_ask])).toEqual([['NOTIFY feedback holders', null]]);
    expect(acts[0]?.did).toContain(`about ${fb.key}`);
    expect(acts[0]?.did).toContain('Recommended: triage it again now');
    expect(await runsOn(fb.id)).toEqual([{ state: 'done' }]);
    expect(await openAbout(fb.key)).toEqual([]);
    const told = await toldOf(fb.key);
    expect(told.map((t) => t.user_id)).toEqual([ownerId]);
    expect(told[0]?.title).toBe(`${fb.key}: triage asked`);
  });

  it('a later sweep on the unchanged standing raises nothing and asks nobody again', async () => {
    const tally = await sweepAndRun(noteOnly(fb));
    expect(tally.stuck).toBe(0);
    expect(await runsOn(fb.id)).toHaveLength(1);
    expect(await toldOf(fb.key)).toHaveLength(1);
  });

  it("the turn's own wake about the triage goes to the holders as well", async () => {
    const own = await feedbackItem();
    standings = [triageAgain(own, 'again-own')];
    await sweepAndRun([
      {
        tool: {
          name: 'steward_wake_master',
          args: {
            about: own.key,
            ask: `Route ${own.key} to a live issue; its carrier was dropped.`,
          },
        },
      },
      { text: 'Asked who may triage it.' },
    ]);
    expect((await actsOn(own.id)).map((a) => a.door)).toEqual(['NOTIFY feedback holders']);
    expect((await toldOf(own.key)).map((t) => t.user_id)).toEqual([ownerId]);
    expect(await openAbout(own.key)).toEqual([]);
  });
});

describe('a diagnosis an earlier build left on its note alone is diagnosed again, once (c3)', () => {
  it('raises it once, asks, and then raises it no more', async () => {
    const old = await feedbackItem();
    standings = [triageAgain(old, 'noted-1')];
    // what dev.299 left on FB-79: a done diagnosis on the standing now, whose one act is the note
    const [run] = await rows<{ id: string }>(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                                acts_to_run, basis, state, not_before, started_at, ended_at)
      VALUES (${projectId}, 'feedback', ${old.id}, ${old.key}, 'standing.stuck', '[]'::jsonb,
              ARRAY['stuck_diagnosis'], 'noted-1', 'done', now(), now(), now())
      RETURNING id`);
    await rows(sql`
      INSERT INTO steward_acts (run_id, project_id, act, door, did)
      VALUES (${run?.id}, ${projectId}, 'stuck_diagnosis',
              ${`PUT /api/projects/${projectId}/steward-notes/feedback/${old.key}`},
              ${`Wrote the note on ${old.key}: it waits to be triaged again.`})
      RETURNING id`);
    const first = await sweepAndRun(noteOnly(old));
    expect(first.stuck).toBe(1);
    expect((await actsOn(old.id)).map((a) => a.door).at(-1)).toBe('NOTIFY feedback holders');
    const again = await sweepAndRun(noteOnly(old));
    expect(again.stuck).toBe(0);
    expect(await runsOn(old.id)).toHaveLength(2);
    expect(await toldOf(old.key)).toHaveLength(1);
  });
});

describe('a master that holds feedback.approve is the one asked (c3, boundary)', () => {
  it('wakes the master and tells no holder', async () => {
    await setMasterGrants(['feedback.approve']);
    const fb = await feedbackItem();
    standings = [triageAgain(fb, 'master-1')];
    await sweepAndRun(noteOnly(fb));
    const acts = await actsOn(fb.id);
    expect(acts.map((a) => a.door).at(-1)).toBe('WAKE master.wake steward');
    expect(await openAbout(fb.key)).toEqual([
      expect.objectContaining({
        ask: expect.stringContaining(`${fb.key}: ${fb.key} has waited on a holder`),
      }),
    ]);
    expect(await toldOf(fb.key)).toEqual([]);
    await setMasterGrants([]);
  });
});

// ISS-590 round 2: on a box a person admin paired, the master is the agent its pane writes as. forge-dev's
// shape: that agent holds feedback.approve, so the master is still asked; without it, the holders are,
// though the person who paired the box holds it.
describe('a box a person admin paired, its pane writing as the project agent (ISS-590)', () => {
  it('wakes the master where the agent it writes as holds feedback.approve', async () => {
    await rows(sql`DELETE FROM runners WHERE device_id = ${deviceId} RETURNING id`);
    ({ deviceId } = await pairTestBox(projectId, { pairedBy: ownerId, actsAs: masterId }));
    await setMasterGrants(['feedback.approve']);
    const fb = await feedbackItem();
    standings = [triageAgain(fb, 'person-paired-master')];
    await sweepAndRun(noteOnly(fb));
    expect((await actsOn(fb.id)).map((a) => a.door).at(-1)).toBe('WAKE master.wake steward');
    expect(await toldOf(fb.key)).toEqual([]);
    await setMasterGrants([]);
  });

  it('asks the holders by name, never the master, where that agent does not hold it', async () => {
    const fb = await feedbackItem();
    standings = [triageAgain(fb, 'person-paired-holders')];
    await sweepAndRun(noteOnly(fb));
    expect((await actsOn(fb.id)).map((a) => [a.door, a.master_ask])).toEqual([
      ['NOTIFY feedback holders', null],
    ]);
    expect(await openAbout(fb.key)).toEqual([]);
    expect((await toldOf(fb.key)).map((t) => t.user_id)).toEqual([ownerId]);
  });
});

describe('where nobody holds feedback.approve, nobody is asked and the item says why (c3, negative)', () => {
  it('logs why on the item, asks nobody, and is not raised again', async () => {
    // the owner keeps the project, but no longer holds the triage: a viewer, outside any org admin
    await rows(sql`
      UPDATE project_members SET role = 'viewer', grants = ARRAY[]::text[]
       WHERE project_id = ${projectId} AND user_id = ${ownerId} RETURNING user_id`);
    await rows(sql`
      DELETE FROM organization_members WHERE user_id = ${ownerId} RETURNING user_id`);
    const fb = await feedbackItem();
    standings = [triageAgain(fb, 'nobody-1')];
    await sweepAndRun(noteOnly(fb));
    const last = (await actsOn(fb.id)).at(-1);
    expect(last?.door).toBe('SAY nobody asked');
    expect(last?.did).toContain(`Asked nobody about ${fb.key}`);
    expect(last?.did).toContain('nobody on this project holds feedback.approve');
    expect(last?.did).not.toMatch(/ask nothing/i);
    expect(await openAbout(fb.key)).toEqual([]);
    expect(await toldOf(fb.key)).toEqual([]);
    const again = await sweepAndRun(noteOnly(fb));
    expect(again.stuck).toBe(0);
    standings = [];
  });
});
