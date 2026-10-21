// REQ-48, lanes A and B together: a requirement nobody owns is read stuck `no_owner` by lane A's real
// standing read (`openStandings`, provided at boot, no fake), the steward's sweep emits it, the next
// run acts on it, and the note it writes goes through `writeStewardNote`'s vet: a note whose claims
// contradict the standing is refused naming the field and writes nothing, and one that copies the
// standing's fields is kept as the item's current note, not stale. The gateway is a scripted provider.
//
// @direct-test-of packages/core/src/standing-ports.ts
// @direct-test-of packages/core/src/steward/door-writes.ts

import type { ItemStanding } from '@forge/contracts/steward';
import { basisFieldsOf, STEWARD_DEBOUNCE_MS } from '@forge/contracts/steward';
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

/** The note the standing itself supports: its claims copied field for field from the read. */
function noteFor(standing: ItemStanding) {
  const f = basisFieldsOf(standing);
  return {
    lines: [
      `${standing.subject.key} is agreed and nobody owns it, so nothing it owes reaches anyone.`,
      'Next: the steward names its author as owner today.',
    ],
    cites: [{ kind: 'requirement', ref: standing.subject.key }],
    claims: {
      group: f.group,
      waitingKind: f.waitingKind,
      ref: f.ref,
      stuck: f.stuckCode !== null,
      stuckCode: f.stuckCode,
      dueAt: f.dueAt,
    },
    basis: standing.basis,
  };
}

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
  it("keeps the note that copies the standing as the item's current note", async () => {
    let good: ReturnType<typeof noteFor> | null = null;
    const { req, run, acts, notes } = await diagnose('Ward lists read by floor', (read) => {
      good = noteFor(read);
      return [{ tool: { name: 'steward_write_note', args: good } }, { text: 'Wrote the note.' }];
    });
    const lines = (good as ReturnType<typeof noteFor> | null)?.lines;
    expect(run).toMatchObject({ state: 'done', failure: null });
    expect(acts.map((a) => a.door)).toEqual([
      `PUT /api/projects/${projectId}/steward-notes/requirement/${req.key}`,
    ]);
    expect(notes).toEqual([{ run_id: run.id, lines }]);
    const after = (await openStandings(projectId)).find((s) => s.subject.id === req.id);
    expect(after?.note).toMatchObject({ lines, stale: false, runId: run.id });
    expect(after?.note?.writtenBy.kind).toBe('agent');
  });

  it('refuses a note that contradicts the standing by name, and writes nothing', async () => {
    const { run, acts, notes } = await diagnose('Discharge letters in large type', (read) => {
      const bad = noteFor(read);
      return [
        {
          tool: {
            name: 'steward_write_note',
            args: { ...bad, claims: { ...bad.claims, stuck: false, stuckCode: null } },
          },
        },
        { text: 'Wrote the note.' },
      ];
    });
    expect(run.state).toBe('failed');
    expect(run.failure).toContain('STEWARD_NOTE_CONTRADICTS');
    expect(run.failure).toContain('the note claims stuck false; the standing reads true');
    expect(acts).toEqual([]);
    expect(notes).toEqual([]);
  });
});
