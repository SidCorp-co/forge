// REQ-48, lanes A and B together: a requirement nobody owns is read stuck `no_owner` by lane A's real
// standing read (`openStandings`, provided at boot, no fake), the steward's sweep emits it, the next
// run acts on it, and the note it writes goes through `writeStewardNote`'s vet. The model writes the
// two lines alone; the door copies the claims, basis and cites from the standing the run read, so a
// note is kept as the item's current note, not stale. A note whose words contradict the standing is
// refused naming the line and writes nothing, a model that sends claims is refused by the tool before
// any door, and a standing that moved under the run is read again and the note written once against
// it. A diagnosis whose turn wrote only the note, or nothing, still ends asking whoever owes the act
// (ISS-654): its one other act is that wake. The gateway is a scripted provider.
//
// @direct-test-of packages/core/src/steward/diagnosis-end.ts
// @direct-test-of packages/core/src/standing-ports.ts
// @direct-test-of packages/core/src/steward/door-writes.ts

import type { ItemStanding } from '@forge/contracts/steward';
import { STEWARD_DEBOUNCE_MS } from '@forge/contracts/steward';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { createTestProject, createTestUser, makeAgreeReady, rows } from '../helpers/factories.js';
import { resetScript, script } from '../helpers/scripted-chat.js';

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/llm/chat.js')>()),
  openChat: (await import('../helpers/scripted-chat.js')).scriptedOpenChat,
}));

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
const at = (path: string) => `/api/projects/${projectId}${path}`;
const as = (method: string, path: string, body?: unknown) => say('owner', method, at(path), body);

type Runtime = typeof import('../../src/steward/dispatch.js') &
  typeof import('../../src/steward/sweep.js');
let steward: Runtime;
let openStandings: (projectId: string) => Promise<ItemStanding[]>;

/** An agreed requirement whose owner is cleared, so the standing reads it stuck `no_owner`. */
async function ownerless(title: string): Promise<{ key: string; id: string }> {
  const key = ok(
    await as('POST', '/requirements', {
      title,
      reason: 'the rule it states',
      criteria: [{ body: 'A ward list reads by floor.' }],
    }),
    201,
  ).key as string;
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  ok(await as('POST', `/requirements/${key}/revisions/1/propose`, {}));
  ok(await as('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'BA review' }));
  ok(await as('POST', `/requirements/${key}/agree`, { revision: 1, reason: 'owner signed r1' }));
  const id = (ok(await as('GET', `/requirements/${key}`)) as Doc).id as string;
  // the agreement's own intake check runs first and settles, so the stuck read is a run of its own
  await settleOutbox();
  resetScript();
  script.steps = [{ text: 'The intake holds.' }];
  await steward.dispatchStewardRuns(later(new Date()));
  await rows(sql`UPDATE requirements SET owner_id = NULL WHERE id = ${id}`);
  return { key, id };
}

/** A tick past the debounce of anything queued at `from`. */
const later = (from: Date) => new Date(from.getTime() + STEWARD_DEBOUNCE_MS + 30_000);

/** The two lines the model writes; everything else the door copies from the standing. */
const linesOf = (key: string) => [
  `${key} is agreed and nobody owns it, so nothing it owes reaches anyone.`,
  'Next: the steward names its author as owner today.',
];

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  steward = {
    ...(await import('../../src/steward/dispatch.js')),
    ...(await import('../../src/steward/sweep.js')),
  } as Runtime;
  ({ openStandings } = await import('../../src/standing/index.js'));
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  say = requester(app, { owner: await signUserToken(ownerId) });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

type RunRow = { id: string; state: string; acts_to_run: string[]; failure: string | null };

/** A stuck requirement's diagnosis run, with the steward's turn scripted as `steps`. */
async function diagnose(title: string, steps: (read: ItemStanding) => unknown[]) {
  const req = await ownerless(title);
  const read = (await openStandings(projectId)).find((s) => s.subject.id === req.id);
  expect(read?.stuck?.code).toBe('no_owner');
  const t0 = new Date();
  expect((await steward.sweepStandings(t0)).stuck).toBeGreaterThanOrEqual(1);
  await settleOutbox();
  resetScript();
  script.steps = steps(read as ItemStanding) as typeof script.steps;
  await steward.dispatchStewardRuns(later(t0));
  const runs = await rows<RunRow>(sql`
    SELECT id, state, acts_to_run, failure FROM steward_runs WHERE subject_id = ${req.id} ORDER BY queued_at`);
  expect(runs.map((r) => r.acts_to_run)).toEqual([['intake_check'], ['stuck_diagnosis']]);
  const run = runs[1] as RunRow;
  const acts = await rows<{ door: string }>(
    sql`SELECT door FROM steward_acts WHERE run_id = ${run.id} ORDER BY at`,
  );
  const notes = await rows<{ run_id: string | null; lines: string[] }>(sql`
    SELECT run_id, lines FROM steward_notes WHERE subject_id = ${req.id}`);
  return { req, read: read as ItemStanding, run, acts, notes };
}

describe("a real stuck item, read through lane A's standing, is acted on and noted (BC-5, BC-7, BC-8)", () => {
  it("keeps the note whose claims the door copied from the standing as the item's current note", async () => {
    let lines: string[] = [];
    const { req, read, run, acts, notes } = await diagnose('Ward lists read by floor', (read) => {
      lines = linesOf(read.subject.key);
      return [
        { tool: { name: 'steward_write_note', args: { lines } } },
        { text: 'Wrote the note.' },
      ];
    });
    expect(run).toMatchObject({ state: 'done', failure: null });
    expect(acts.map((a) => a.door)).toEqual([
      `PUT /api/projects/${projectId}/steward-notes/requirement/${req.key}`,
      'WAKE master.wake steward',
    ]);
    expect(notes).toEqual([{ run_id: run.id, lines }]);
    const after = (await openStandings(projectId)).find((s) => s.subject.id === req.id);
    expect(after?.note).toMatchObject({
      lines,
      stale: false,
      runId: run.id,
      basis: read.basis,
      claims: { stuck: true, stuckCode: 'no_owner', ref: read.waitingOn.ref },
      cites: [{ kind: 'requirement', ref: req.key }],
    });
    expect(after?.note?.writtenBy.kind).toBe('agent');
  });

  it('refuses a note whose words contradict the standing by name, and writes nothing', async () => {
    const { run, acts, notes } = await diagnose('Discharge letters in large type', (read) => [
      {
        tool: {
          name: 'steward_write_note',
          args: { lines: [`${read.subject.key} is moving: its owner works on it.`] },
        },
      },
      { text: 'Wrote the note.' },
    ]);
    expect(run).toMatchObject({ state: 'failed' });
    expect(run.failure).toContain('STEWARD_NOTE_CONTRADICTS');
    expect(run.failure).toContain('STEWARD_NOTE_CONTRADICTS at /lines/0: line 1 says');
    // no note was written; the diagnosis still ends asking whoever owes the act
    expect(acts).toEqual([{ door: 'WAKE master.wake steward' }]);
    expect(notes).toEqual([]);
  });

  it('refuses claims from the model before any door, so a guess never reaches the vet', async () => {
    const { run, acts, notes } = await diagnose('Ward rounds list the night nurse', (read) => [
      {
        tool: {
          name: 'steward_write_note',
          args: { lines: linesOf(read.subject.key), claims: { ref: 'Master' } },
        },
      },
      { text: 'Could not write the note.' },
    ]);
    // the tool refused the shape in the turn; no door was called, so nothing was refused or written
    expect(run).toMatchObject({ state: 'done', failure: null });
    expect(acts).toEqual([{ door: 'WAKE master.wake steward' }]);
    expect(notes).toEqual([]);
    const reply = JSON.stringify(script.sent.at(-1));
    expect(reply).toContain('steward_write_note');
    expect(reply).toContain('claims');
  });

  it('reads a standing that moved under the run again, and writes the note once against it', async () => {
    let lines: string[] = [];
    const { req, read, run, acts, notes } = await diagnose(
      'Ward boards show the shift lead',
      (read) => {
        lines = [`${read.subject.key} had no owner; the steward named its author.`];
        return [
          // naming the owner moves the standing off the basis the run read
          {
            tool: {
              name: 'steward_set_requirement_owner',
              args: { requirement: read.subject.key },
            },
          },
          { tool: { name: 'steward_write_note', args: { lines } } },
          { text: 'Named the owner and wrote the note.' },
        ];
      },
    );
    expect(run).toMatchObject({ state: 'done', failure: null });
    expect(acts.map((a) => a.door)).toEqual([
      `PATCH /api/projects/${projectId}/requirements/${req.key}`,
      `PUT /api/projects/${projectId}/steward-notes/requirement/${req.key}`,
    ]);
    expect(notes).toEqual([{ run_id: run.id, lines }]);
    const after = (await openStandings(projectId)).find((s) => s.subject.id === req.id);
    expect(after?.basis).not.toBe(read.basis);
    expect(after?.note).toMatchObject({ lines, stale: false, basis: after?.basis });
  });
});
