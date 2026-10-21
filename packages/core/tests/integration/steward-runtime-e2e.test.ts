// REQ-48 lane B (ISS-596): the steward runtime, driven through the real app, outbox and timers on a
// throwaway Postgres, with the gateway a scripted provider. A requirement agreed and its breakdown
// proposed fold into one debounced run; what arrives while a run runs is its one rerun, no act
// dropped; a spent budget skips the run and the item says so; a stuck item is acted on within the
// hour, not again on the same basis, and its acts are undone through the undo door or refused by
// name; and a steward turn reaches nothing outside its act's menu. The standing read is replaced
// here by a scripted one of its contract type (`OpenStandingsRead`), so each case states exactly the
// standing it acts on; the real read, provided at boot, is driven in steward-standing-e2e.
//
// @direct-test-of packages/core/src/steward/consumer.ts
// @direct-test-of packages/core/src/steward/runs-store.ts
// @direct-test-of packages/core/src/steward/dispatch.ts
// @direct-test-of packages/core/src/steward/sweep.ts
// @direct-test-of packages/core/src/steward/acts-store.ts
// @direct-test-of packages/core/src/steward/routes.ts
// @direct-test-of packages/core/src/db/schema-steward-runs.ts

import type { Said } from '@forge/contracts/said';
import {
  type ItemStanding,
  STEWARD_DEBOUNCE_MS,
  STEWARD_STUCK_ACT_WITHIN_MS,
  type StandingSubject,
} from '@forge/contracts/steward';
import { STEWARD_ACT_DOORS } from '@forge/contracts/steward-runtime';
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
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  rows,
} from '../helpers/factories.js';
import { resetScript, script } from '../helpers/scripted-chat.js';

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/llm/chat.js')>()),
  openChat: (await import('../helpers/scripted-chat.js')).scriptedOpenChat,
}));

type Steward = typeof import('../../src/steward/runs-store.js') &
  typeof import('../../src/steward/dispatch.js') &
  typeof import('../../src/steward/sweep.js');

let steward: Steward;
let emit: (
  type: 'standing.changed' | 'standing.stuck',
  subject: StandingSubject,
  basis: string,
) => Promise<void>;
let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
/** What lane A's standing read answers for this project, test by test. */
let standings: ItemStanding[] = [];
const at = (path: string) => `/api/projects/${projectId}${path}`;
const as = (method: string, path: string, body?: unknown) => say('owner', method, at(path), body);

interface RunRead {
  id: string;
  state: string;
  acts_to_run: string[];
  follow_up: string[];
  events: { trigger: string; at: string }[];
  basis: string | null;
  skip_reason: string | null;
  not_before: string;
  started_at: string | null;
}

const runsOf = (subjectId: string) =>
  rows<RunRead>(sql`
    SELECT id, state, acts_to_run, follow_up, events, basis, skip_reason,
           not_before::text, started_at::text
      FROM steward_runs WHERE subject_id = ${subjectId} ORDER BY queued_at, id`);

/** A sentence the fake read carries; nothing here renders it. */
const said = (text: string) => ({ key: text }) as unknown as Said;

function stuckIssue(issue: { id: string; key: string }, basis: string): ItemStanding {
  const says = { who: said('Master'), act: said('take it'), rule: said('nobody serves') };
  return {
    subject: { kind: 'issue', id: issue.id, key: issue.key },
    title: 'issue',
    group: 'stuck',
    waitingOn: {
      kind: 'master',
      who: 'Master',
      act: 'take it',
      rule: 'nobody serves',
      ref: null,
      dueAt: null,
      says,
    },
    note: null,
    actClass: 'master_take',
    since: '2026-10-14T00:00:00.000Z',
    dueAt: null,
    stuck: {
      code: 'nobody_serves',
      since: '2026-10-14T00:00:00.000Z',
      reason: `${issue.key} was sent back and no master serves this project`,
      via: null,
      says: { reason: said('no master serves this project') },
    },
    carriedBy: null,
    basis,
  };
}

async function agreedRequirement(title: string): Promise<{ key: string; id: string }> {
  const key = ok(
    await as('POST', '/requirements', {
      title,
      reason: 'the rule it states',
      criteria: [{ body: 'A saved board shows every card it had.' }],
    }),
    201,
  ).key as string;
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  ok(await as('POST', `/requirements/${key}/revisions/1/propose`, {}));
  ok(await as('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'BA review' }));
  ok(await as('POST', `/requirements/${key}/agree`, { revision: 1, reason: 'owner signed r1' }));
  const id = (ok(await as('GET', `/requirements/${key}`)) as Doc).id as string;
  return { key, id };
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  const { provideStewardStandings } = await import('../../src/steward/index.js');
  provideStewardStandings(async (pid) => (pid === projectId ? standings : []));
  await startQueue();
  steward = {
    ...(await import('../../src/steward/runs-store.js')),
    ...(await import('../../src/steward/dispatch.js')),
    ...(await import('../../src/steward/sweep.js')),
  } as Steward;
  const { db } = await import('../../src/db/client.js');
  const { emitEvent } = await import('../../src/outbox/index.js');
  emit = (type, subject, basis) =>
    db.transaction((tx) =>
      type === 'standing.stuck'
        ? emitEvent(tx, type, { projectId, subject, basis, code: 'nobody_serves' })
        : emitEvent(tx, type, { projectId, subject, basis }),
    );
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  say = requester(app, { owner: await signUserToken(ownerId) });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe("a trigger folds into the item's one live run (BC-1)", () => {
  let req: { key: string; id: string };
  let runId = '';

  it('gives one run for two events within 2 minutes, both acts in order, due 2 minutes after the first', async () => {
    req = await agreedRequirement('The board keeps its cards');
    ok(
      await as('POST', '/suggestions', {
        kind: 'breakdown',
        requirement: req.key,
        baseRevision: 1,
        payload: {
          issues: [
            {
              title: 'Save every card',
              criteria: [{ body: 'a reload shows every card', tracesTo: 'BC-1' }],
              complexity: 's',
              builds: null,
            },
          ],
        },
      }),
      201,
    );
    await settleOutbox();
    const runs = await runsOf(req.id);
    expect(runs.map((r) => [r.state, r.acts_to_run])).toEqual([
      ['queued', ['intake_check', 'breakdown_check']],
    ]);
    const [run] = runs;
    expect(run?.events.map((e) => e.trigger)).toEqual(['requirement.agreed', 'breakdown.proposed']);
    const first = new Date(run?.events[0]?.at ?? 0).getTime();
    expect(new Date(run?.not_before ?? 0).getTime() - first).toBe(STEWARD_DEBOUNCE_MS);
    runId = run?.id ?? '';
  });

  it('keeps what arrives while the run runs as exactly one rerun, dropping no act', async () => {
    const claimed = await steward.claimDueRuns(
      new Date(Date.now() + STEWARD_DEBOUNCE_MS + 1_000),
      50,
    );
    expect(claimed.map((r) => r.id)).toContain(runId);
    const subject = { kind: 'requirement' as const, id: req.id, key: req.key };
    await emit('standing.changed', subject, 'b1');
    await emit('standing.stuck', subject, 'b1');
    await emit('standing.changed', subject, 'b2');
    await settleOutbox();
    const during = await runsOf(req.id);
    expect(during.map((r) => [r.state, r.follow_up])).toEqual([
      ['running', ['note', 'stuck_diagnosis']],
    ]);

    const next = await steward.endRun(runId, { state: 'done' });
    const after = await runsOf(req.id);
    expect(after.map((r) => [r.id === next, r.state, r.acts_to_run])).toEqual([
      [false, 'done', ['intake_check', 'breakdown_check']],
      [true, 'queued', ['note', 'stuck_diagnosis']],
    ]);
    expect(after[1]?.events.map((e) => e.trigger)).toEqual([
      'standing.changed',
      'standing.stuck',
      'standing.changed',
    ]);
    await steward.claimDueRuns(new Date(Date.now() + 1_000), 50);
    await steward.endRun(next ?? '', { state: 'skipped', reason: 'subject_ended' });
  });

  it("holds the breakdown out of the master's work while the intake question waits, until someone replies", async () => {
    const { breakdownsHeldBySteward } = await import('../../src/steward/index.js');
    const stewardUser = (await createTestUser({ kind: 'agent' })).id;
    const [question] = await rows<{ id: string }>(sql`
      INSERT INTO comments (requirement_id, author_id, body, intent)
      VALUES (${req.id}, ${stewardUser}, 'Which board does BC-1 mean? Options: a: saved; b: shared. Recommended: a.', 'question')
      RETURNING id`);
    await rows(sql`
      INSERT INTO steward_acts (run_id, project_id, act, door, did, wrote)
      VALUES (${runId}, ${projectId}, 'intake_check', 'POST requirements comments', 'Asked on the requirement',
              ${JSON.stringify({ kind: 'comment', ref: question?.id })}::jsonb)`);
    expect(await breakdownsHeldBySteward(projectId)).toEqual([req.key]);

    ok(
      await as('POST', `/requirements/${req.key}/comments`, {
        intent: 'note',
        body: 'The saved board.',
        parentId: question?.id,
      }),
      201,
    );
    expect(await breakdownsHeldBySteward(projectId)).toEqual([]);
  });
});

describe('a spent budget skips the run and says so (cost guard)', () => {
  it('skips the run budget_spent before any turn, and the item reads why', async () => {
    const issue = await createTestIssue(projectId, ownerId, 40, {
      status: 'open',
      createdAt: new Date(),
    });
    const spent = await rows<{ id: string }>(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                                state, turns, not_before, started_at, ended_at)
      VALUES (${projectId}, 'issue', ${issue.id}, ${issue.key}, 'standing.stuck', '[]'::jsonb, ARRAY['stuck_diagnosis'],
              'done', 200, now(), now(), now())
      RETURNING id`);
    standings = [stuckIssue(issue, 'spent-1')];
    await emit('standing.stuck', standings[0]?.subject as StandingSubject, 'spent-1');
    await settleOutbox();
    resetScript();
    await steward.dispatchStewardRuns(new Date(Date.now() + STEWARD_DEBOUNCE_MS + 30_000));

    const runs = await runsOf(issue.id);
    expect(runs.at(-1)).toMatchObject({ state: 'skipped', skip_reason: 'budget_spent' });
    expect(script.sent).toEqual([]);
    const read = ok(await as('GET', `/steward-runs?subject=${issue.key}`));
    expect((read.runs as Doc[])[0]).toMatchObject({ state: 'skipped', skipReason: 'budget_spent' });
    await rows(sql`DELETE FROM steward_runs WHERE id = ${spent[0]?.id}`);
    standings = [];
  });
});

describe('a stuck item is acted on within the hour, once per basis (BC-5)', () => {
  let issue: { id: string; key: string };
  let acts: { id: string; door: string; master_ask: string | null }[] = [];

  it('is emitted by the sweep, acted on by the next run, and not diagnosed again on the same basis', async () => {
    issue = await createTestIssue(projectId, ownerId, 41, {
      status: 'reopen',
      createdAt: new Date(),
    });
    standings = [stuckIssue(issue, 'basis-1')];
    const t0 = new Date();
    expect((await steward.sweepStandings(t0)).stuck).toBe(1);
    await settleOutbox();
    expect((await steward.sweepStandings(t0)).stuck).toBe(0);

    resetScript();
    script.steps = [
      {
        tool: {
          name: 'steward_wake_master',
          args: { about: issue.key, ask: `${issue.key} waits for a master since 10-14` },
        },
      },
      {
        tool: {
          name: 'steward_comment_issue',
          args: {
            issue: issue.key,
            body: 'No master serves this project; the master was asked to take it.',
          },
        },
      },
      { tool: { name: 'forge_cli', args: { argv: ['issue', 'close', issue.key] } } },
      { text: 'Woke the master and said why on the issue.' },
    ];
    const tick = new Date(t0.getTime() + STEWARD_DEBOUNCE_MS + 30_000);
    await steward.dispatchStewardRuns(tick);

    const [run] = await runsOf(issue.id);
    expect(run).toMatchObject({
      state: 'done',
      acts_to_run: ['stuck_diagnosis'],
      basis: 'basis-1',
    });
    expect(new Date(run?.started_at ?? 0).getTime() - t0.getTime()).toBeLessThan(
      STEWARD_STUCK_ACT_WITHIN_MS,
    );
    acts = await rows(
      sql`SELECT id, door, master_ask FROM steward_acts WHERE run_id = ${run?.id} ORDER BY at`,
    );
    expect(acts.map((a) => a.door)).toEqual([
      'WAKE master.wake steward',
      `POST /api/issues/${issue.id}/comments`,
    ]);
    expect(await steward.openStewardAsks(projectId)).toHaveLength(1);
    expect((await steward.sweepStandings(new Date())).stuck).toBe(0);
  });

  it("offers the turn its act's doors alone, and refuses any other by name with nothing written", () => {
    expect(script.offered[0]).toEqual([...STEWARD_ACT_DOORS.stuck_diagnosis]);
    const fed = JSON.stringify(script.sent.at(-1));
    expect(fed).toContain('TURN_ORIGIN_REFUSED');
    expect(fed).toContain('forge_cli');
    expect(acts).toHaveLength(2);
  });

  it('is diagnosed again once its standing moves, which settles the ask of the master', async () => {
    standings = [stuckIssue(issue, 'basis-2')];
    expect((await steward.sweepStandings(new Date())).stuck).toBe(1);
    expect(await steward.openStewardAsks(projectId)).toEqual([]);
    await settleOutbox();
    const runs = await runsOf(issue.id);
    expect(runs.map((r) => [r.state, r.basis])).toEqual([
      ['done', 'basis-1'],
      ['queued', 'basis-2'],
    ]);
    await steward.claimDueRuns(new Date(Date.now() + STEWARD_DEBOUNCE_MS + 1_000), 50);
    await steward.endRun(runs[1]?.id ?? '', { state: 'skipped', reason: 'subject_ended' });
    standings = [];
  });

  it('undoes an act through its inverse door once, and refuses an act with none by name (BC-12)', async () => {
    const comment = acts.find((a) => a.door.endsWith('/comments'));
    const undone = await as('POST', `/steward-acts/${comment?.id}/undo`);
    expect(undone.status, JSON.stringify(undone.json)).toBe(200);
    expect(undone.json.undone).toMatchObject({
      door: expect.stringMatching(/^DELETE \/api\/comments\//),
    });
    expect(undone.json.act.undoneBy).toBe(ownerId);
    const left = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM comments WHERE issue_id = ${issue.id}`);
    expect(left[0]?.n).toBe(0);

    const again = await as('POST', `/steward-acts/${comment?.id}/undo`);
    expect([again.status, again.json.code]).toEqual([409, 'STEWARD_ACT_SUPERSEDED']);

    const wake = acts.find((a) => a.master_ask !== null);
    const refused = await as('POST', `/steward-acts/${wake?.id}/undo`);
    expect([refused.status, refused.json.code]).toEqual([422, 'STEWARD_ACT_NOT_UNDOABLE']);
    expect(refused.json.detail).toContain('nothing to undo: a wake only asks the master');

    const unknown = await as('POST', '/steward-acts/00000000-0000-4000-8000-000000000000/undo');
    expect([unknown.status, unknown.json.code]).toEqual([404, 'STEWARD_ACT_UNKNOWN']);
  });
});
