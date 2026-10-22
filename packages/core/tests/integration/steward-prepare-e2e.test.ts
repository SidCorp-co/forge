// REQ-48 BC-5, the coordinator's ruling of 2026-10-22: a person is never asked to write a plan or
// criteria. The steward prepares a stale draft first, as its own acts through the issue's doors:
// it links the agreed requirement the draft delivers, saves a short plan (recording that
// requirement's current revision) and writes criteria traced to its BCs, each a checkable statement.
// A prepared draft is asked open, recommending open. Where no agreed requirement fits, the steward
// asks link (its candidates), requirement or drop, and the answer acts: link links the draft and has
// it diagnosed again, which prepares it and asks open, under the same daily budget; requirement
// starts a requirement from the draft's feedback; drop drops it.
//
// @direct-test-of packages/core/src/steward/door-prepare.ts
// @direct-test-of packages/core/src/steward/door-decide.ts
// @direct-test-of packages/core/src/steward/decision-act.ts
// @direct-test-of packages/core/src/steward/undo-rules.ts

import {
  STEWARD_DECISION_OPTION_IDS as IDS,
  STEWARD_DEBOUNCE_MS,
  stewardLinkOptionId,
} from '@forge/contracts/steward';
import { eq, sql } from 'drizzle-orm';
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
  completeIssueReadyRecord,
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

type Call = { name: string; args: Record<string, unknown> };

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let stewardId = '';
let lastRunId = '';
let diagnose: (issue: { id: string; key: string }, calls: Call[]) => Promise<string[]>;
let dispatch: (at?: Date) => Promise<unknown>;
const at = (path: string) => `/api/projects/${projectId}${path}`;

/** An agreed requirement `REQ-<seq>` at revision 1 with BC-1 "it holds", delivered by a holder issue. */
async function agreedRequirement(seq: number) {
  const holder = await createTestIssue(projectId, ownerId, 500 + seq, {
    status: 'draft',
    createdAt: new Date(),
  });
  await completeIssueReadyRecord(projectId, ownerId, holder.id, seq);
  return `REQ-${seq}`;
}

const draftIssue = (seq: number) =>
  createTestIssue(projectId, ownerId, seq, {
    status: 'draft',
    createdAt: new Date(Date.now() - 16 * 86_400_000),
  });

const prepare = (
  key: string,
  requirement: string,
  statement = 'A reload shows every saved card',
) => ({
  name: 'steward_prepare_draft',
  args: {
    issue: key,
    requirement,
    plan: 'Deliver the saved board the feedback reports missing, as BC-1 reads it.',
    criteria: [{ statement, bc: 'BC-1' }],
  },
});

const decide = (
  key: string,
  recommended: string,
  candidates?: { requirement: string; bc: string }[],
) => ({
  name: 'steward_decide',
  args: {
    about: key,
    recommended,
    ...(candidates ? { candidates } : {}),
    why: 'the carried feedback asks for exactly this',
  },
});

const issueRow = async (id: string) =>
  (
    await rows<{
      status: string;
      requirement_id: string | null;
      planned_revision: number | null;
      plan: string | null;
    }>(sql`SELECT status, requirement_id, planned_revision, plan FROM issues WHERE id = ${id}`)
  )[0];

const criteriaOf = (id: string) =>
  rows<{ statement: string; code: string | null }>(sql`
    SELECT c.statement, r.code FROM issue_criteria c
      LEFT JOIN requirement_criteria r ON r.id = c.requirement_criterion_id
     WHERE c.issue_id = ${id} AND c.retired_at IS NULL ORDER BY c.n`);

const openQuestion = async (issueId: string) => {
  const open = await rows<{ id: string; steps: Doc[] }>(sql`
    SELECT id, steps FROM agent_questions WHERE issue_id = ${issueId} AND status = 'open'`);
  expect(open).toHaveLength(1);
  return { id: open[0]?.id ?? '', step: open[0]?.steps.at(-1) as Doc };
};

const actsOn = (runId: string) =>
  rows<{ id: string; door: string; did: string; undo: Doc | null }>(sql`
    SELECT id, door, did, undo FROM steward_acts WHERE run_id = ${runId} ORDER BY at, id`);

const answer = (questionId: string, body: Record<string, unknown>) =>
  say('owner', 'POST', `/api/questions/${questionId}/answer`, { round: 1, ...body });

const runsOf = (issueId: string) =>
  rows<{ id: string; state: string; skip_reason: string | null; turns: number }>(sql`
    SELECT id, state, skip_reason, turns FROM steward_runs
     WHERE subject_id = ${issueId} AND trigger = 'standing.stuck' AND events <> '[]'::jsonb
     ORDER BY queued_at`);

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const { stewardAccountOf } = await import('../../src/steward/account.js');
  stewardId = await stewardAccountOf(projectId);
  say = requester(app, { owner: await signUserToken(ownerId) });
  const { db } = await import('../../src/db/client.js');
  const { stewardRuns } = await import('../../src/db/schema-steward-runs.js');
  const { runGatewayAct } = await import('../../src/steward/turn.js');
  const { dispatchStewardRuns } = await import('../../src/steward/dispatch.js');
  dispatch = (at = new Date(Date.now() + STEWARD_DEBOUNCE_MS + 30_000)) => dispatchStewardRuns(at);
  diagnose = async (issue, calls) => {
    const [made] = await rows<{ id: string }>(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                                state, not_before, started_at, ended_at)
      VALUES (${projectId}, 'issue', ${issue.id}, ${issue.key}, 'standing.stuck', '[]'::jsonb,
              ARRAY['stuck_diagnosis']::text[], 'done', now(), now(), now())
      RETURNING id`);
    lastRunId = made?.id ?? '';
    const [run] = await db.select().from(stewardRuns).where(eq(stewardRuns.id, lastRunId));
    if (!run) throw new Error('the run row was not written');
    resetScript();
    script.steps = [...calls.map((tool) => ({ tool })), { text: 'Done.' }];
    await runGatewayAct({ run, act: 'stuck_diagnosis', standing: null, stewardId });
    return (script.sent.at(-1) ?? [])
      .filter((m) => m.role === 'tool')
      .map((m) => JSON.stringify(m.content));
  };
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('the steward prepares a draft before it asks anything (REQ-48 BC-5)', () => {
  it('links the agreed requirement, saves the plan at its revision and traces the criteria, then asks open', async () => {
    const req = await agreedRequirement(901);
    const issue = await draftIssue(101);
    const results = await diagnose(issue, [prepare(issue.key, req), decide(issue.key, 'open')]);
    expect(results[0]).toContain(String.raw`\"complete\":true`);
    const row = await issueRow(issue.id);
    expect(row?.planned_revision).toBe(1);
    expect(row?.plan).toContain('saved board');
    expect(await criteriaOf(issue.id)).toEqual([
      { statement: 'A reload shows every saved card', code: 'BC-1' },
    ]);
    const acts = await actsOn(lastRunId);
    expect(acts.map((a) => a.door)).toEqual([
      `POST /api/projects/${projectId}/requirements/${req}/issues`,
      `PATCH /api/issues/${issue.id}`,
      `PUT /api/issues/${issue.id}/criteria`,
      `POST /api/projects/${projectId}/steward-runs/${lastRunId}/decisions`,
    ]);
    // each write is undone through its own door
    expect(acts.slice(0, 3).map((a) => (a.undo as Doc | null)?.door)).toEqual([
      `DELETE /api/projects/${projectId}/requirements/${req}/issues/${issue.id}`,
      `PATCH /api/issues/${issue.id}`,
      `PUT /api/issues/${issue.id}/criteria`,
    ]);
    const { id, step } = await openQuestion(issue.id);
    expect(step.recommendedOptionId).toBe(IDS.open);
    expect((step.options as Doc[]).map((o) => o.id)).toEqual([IDS.open, IDS.keep, IDS.drop]);
    const opened = await answer(id, { optionId: IDS.open });
    expect(opened.status, JSON.stringify(opened.json)).toBe(200);
    expect((await issueRow(issue.id))?.status).toBe('open');
  });

  it('undoes each preparing write through its own door, newest first', async () => {
    const req = await agreedRequirement(902);
    const issue = await draftIssue(102);
    await diagnose(issue, [prepare(issue.key, req)]);
    const acts = await actsOn(lastRunId);
    expect(acts).toHaveLength(3);
    for (const act of [...acts].reverse()) {
      ok(await say('owner', 'POST', at(`/steward-acts/${act.id}/undo`), {}));
    }
    const row = await issueRow(issue.id);
    expect([row?.requirement_id, row?.plan]).toEqual([null, null]);
    expect(await criteriaOf(issue.id)).toEqual([]);
  });

  it('refuses a criterion that is an instruction, a requirement not agreed, and a BC it lacks', async () => {
    const req = await agreedRequirement(903);
    const draftReq = (await createTestRequirement(projectId, 904, 'not agreed yet')).key;
    const issue = await draftIssue(103);
    const results = await diagnose(issue, [
      prepare(issue.key, req, 'Verify the cards are saved after a reload'),
      prepare(issue.key, draftReq),
      {
        name: 'steward_prepare_draft',
        args: {
          ...prepare(issue.key, req).args,
          criteria: [{ statement: 'A reload shows the cards', bc: 'BC-9' }],
        },
      },
    ]);
    expect(results[0]).toContain('never an instruction');
    expect(results[1]).toContain(
      `${draftReq} is draft: a draft delivers only an agreed or accepted requirement`,
    );
    expect(results[2]).toContain(`${req} revision 1 has no BC-9; its BCs are BC-1`);
    const row = await issueRow(issue.id);
    expect([row?.requirement_id, row?.plan]).toEqual([null, null]);
    expect(await actsOn(lastRunId)).toEqual([]);
  });
});

describe('where no agreed requirement fits, the answer acts (REQ-48 BC-5)', () => {
  it('asks link, requirement or drop; a link answer links it, and the run it starts prepares it and asks open', async () => {
    const req = await agreedRequirement(905);
    const issue = await draftIssue(104);
    const results = await diagnose(issue, [
      decide(issue.key, 'link', [
        { requirement: req, bc: 'BC-1' },
        { requirement: 'REQ-904', bc: 'BC-1' },
      ]),
      decide(issue.key, 'link', [{ requirement: req, bc: 'BC-1' }]),
    ]);
    expect(results[0]).toContain('candidate REQ-904 BC-1: REQ-904 is draft');
    const { id, step } = await openQuestion(issue.id);
    const link = stewardLinkOptionId(req, 'BC-1');
    expect((step.options as Doc[]).map((o) => [o.id, o.label])).toEqual([
      [link, `Link it to ${req} BC-1: it holds`],
      [IDS.requirement, 'Start a requirement from it'],
      [IDS.drop, 'Drop it: it is not work'],
    ]);
    expect(step.recommendedOptionId).toBe(link);
    expect(step.prompt).toBe(`Link it to ${req} BC-1, start a requirement from it, or drop it?`);
    expect(JSON.stringify(step)).not.toMatch(/write the (details|plan)/i);
    const read = ok(await say('owner', 'GET', at('/needs-you/decisions')));
    const row = (read.decisions as Doc[]).find((d) => d.key === issue.key);
    // each button says what it does to this issue, never that it sends the answer to a run
    expect(((row?.answers ?? []) as Doc[]).map((a) => [a.id, a.needsReason, a.effect])).toEqual([
      [
        link,
        false,
        `Links ${issue.key} to ${req} BC-1 as you; the steward then writes its plan and criteria, and asks whether to open it.`,
      ],
      [
        IDS.requirement,
        false,
        `Starts a requirement from ${issue.key}'s feedback as you; ${issue.key} stays a draft until that requirement is agreed.`,
      ],
      [IDS.drop, true, `Drops ${issue.key} as you, with your reason.`],
    ]);

    const done = await answer(id, { optionId: link });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const linked = await issueRow(issue.id);
    expect([linked?.status, linked?.planned_revision]).toEqual(['draft', null]);
    expect(linked?.requirement_id).not.toBeNull();
    const askRun = lastRunId;
    expect((await actsOn(askRun)).map((a) => a.door)).toEqual([
      `POST /api/projects/${projectId}/steward-runs/${askRun}/decisions`,
      `POST /api/projects/${projectId}/requirements/${req}/issues`,
    ]);

    // the answer has the steward diagnose it again: that run prepares it and asks open, in one turn
    await settleOutbox();
    resetScript();
    script.steps = [
      { tool: prepare(issue.key, req) },
      { tool: decide(issue.key, 'open') },
      { text: 'Prepared and asked.' },
    ];
    await dispatch();
    const [rerun] = await runsOf(issue.id);
    expect(rerun).toMatchObject({ state: 'done', turns: 1 });
    expect((await actsOn(rerun?.id ?? '')).map((a) => a.door)).toEqual([
      `PATCH /api/issues/${issue.id}`,
      `PUT /api/issues/${issue.id}/criteria`,
      `POST /api/projects/${projectId}/steward-runs/${rerun?.id}/decisions`,
    ]);
    const asked = await openQuestion(issue.id);
    expect(asked.step.recommendedOptionId).toBe(IDS.open);
    ok(await answer(asked.id, { optionId: IDS.open }));
    expect((await issueRow(issue.id))?.status).toBe('open');
  });

  it("a requirement answer starts one from the draft's feedback, through the requirement door", async () => {
    const issue = await draftIssue(105);
    const fb = await createTestFeedback(projectId, ownerId, 77, [issue.id]);
    await diagnose(issue, [decide(issue.key, 'requirement')]);
    const { id, step } = await openQuestion(issue.id);
    expect((step.options as Doc[]).map((o) => o.id)).toEqual([IDS.requirement, IDS.drop]);
    const done = await answer(id, { optionId: IDS.requirement });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const [made] = await rows<{ title: string; status: string; reason: string }>(sql`
      SELECT r.title, r.status, v.reason FROM requirements r
        JOIN requirement_revisions v ON v.requirement_id = r.id
       WHERE r.project_id = ${projectId} AND r.title = 'feedback 77'`);
    expect(made?.status).toBe('draft');
    expect(made?.reason).toContain(`Started from ${fb}, carried by ${issue.key}`);
    const acts = await actsOn(lastRunId);
    expect(acts.at(-1)?.door).toBe(`POST /api/projects/${projectId}/requirements`);
    expect((await issueRow(issue.id))?.status).toBe('draft');
  });

  it('two requirement answers sent at once start one requirement, written with the one answer that lands', async () => {
    const issue = await draftIssue(108);
    await createTestFeedback(projectId, ownerId, 78, [issue.id]);
    await diagnose(issue, [decide(issue.key, 'requirement')]);
    const { id } = await openQuestion(issue.id);
    const both = await Promise.all([
      answer(id, { optionId: IDS.requirement }),
      answer(id, { optionId: IDS.requirement }),
    ]);
    // the second waits on the first's lock, then reads the question answered and is refused
    expect(both.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(both.find((r) => r.status === 422)?.json.code).toBe('QUESTION_NOT_OPEN');
    const made = await rows<{ id: string }>(sql`
      SELECT id FROM requirements WHERE project_id = ${projectId} AND title = 'feedback 78'`);
    expect(made).toHaveLength(1);
    const logged = (await actsOn(lastRunId)).filter((a) => a.door.endsWith('/requirements'));
    expect(logged).toHaveLength(1);
  });

  // REQ-41 BC-26 (ruled 2026-10-22): the move out of draft voids the decision in the same write, so
  // it no longer waits on anyone; an answer sent from a card drawn before the move is still refused stale
  it('a link answer on a draft opened since is refused stale, its question voided by the move', async () => {
    const req = await agreedRequirement(911);
    const issue = await draftIssue(106);
    await diagnose(issue, [decide(issue.key, 'link', [{ requirement: req, bc: 'BC-1' }])]);
    const { id } = await openQuestion(issue.id);
    // a person prepares and opens it by hand before answering
    await completeIssueReadyRecord(projectId, ownerId, issue.id, 913);
    ok(
      await say('owner', 'POST', `/api/issues/${issue.id}/transition`, {
        toStatus: 'open',
        reason: 'Opened by hand before the answer.',
      }),
    );
    const stale = await answer(id, { optionId: stewardLinkOptionId(req, 'BC-1') });
    expect([stale.status, stale.json.code]).toEqual([409, 'STEWARD_DECISION_STALE']);
    expect((await issueRow(issue.id))?.status).toBe('open');
    const [q] = await rows<{ status: string; void_reason: string | null }>(sql`
      SELECT status, void_reason FROM agent_questions WHERE id = ${id}`);
    expect(q?.status).toBe('void');
    expect(q?.void_reason).toBe(
      'the issue moved from Draft to Open without this being answered, so the draft it asked about is gone and no answer to it can act: Opened by hand before the answer.',
    );
  });

  it('the run a link answer starts waits for the next day once the day is spent, before any turn', async () => {
    const req = await agreedRequirement(912);
    const issue = await draftIssue(107);
    await diagnose(issue, [decide(issue.key, 'link', [{ requirement: req, bc: 'BC-1' }])]);
    const { id } = await openQuestion(issue.id);
    ok(await answer(id, { optionId: stewardLinkOptionId(req, 'BC-1') }));
    await settleOutbox();
    // the spend is stamped at the dispatch instant, so the two share a UTC day near midnight too
    const at = new Date(Date.now() + STEWARD_DEBOUNCE_MS + 30_000);
    await rows(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                                state, turns, not_before, started_at, ended_at)
      VALUES (${projectId}, 'issue', ${issue.id}, ${issue.key}, 'standing.stuck', '[]'::jsonb,
              ARRAY['stuck_diagnosis'], 'done', 200, now(), ${at.toISOString()}::timestamptz, now())
      RETURNING id`);
    resetScript();
    await dispatch(at);
    const [rerun] = await runsOf(issue.id);
    expect(rerun).toMatchObject({ state: 'queued', skip_reason: null, turns: 0 });
    expect(script.sent).toEqual([]);
    expect((await issueRow(issue.id))?.planned_revision).toBeNull();
  });
});
