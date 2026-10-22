// REQ-48 BC-5, the steward's questions on live dev.269: a stuck issue's question carries Forge's own
// options, the model picking only the recommended one and why. A prepared draft (it passes the
// issue-ready check) is asked open, keep or drop, recommending open; an unprepared one is never asked
// open. Nothing is asked where the wait is somebody's act already, where the question is open, or
// where a person kept the issue on its standing. Answering carries the act out as the answerer, in
// the answer's transaction: open admits the draft through the kernel (a gap refused by the kernel's
// name, the question left open), drop drops it with the reason, keep records the keep. The one-off
// voids the questions asked with options the model spelled, and diagnoses their items again. The
// preparing, the link and the requirement answers: `steward-prepare-e2e.test.ts`.
//
// @direct-test-of packages/core/src/steward/door-decide.ts
// @direct-test-of packages/core/src/steward/decision-act.ts
// @direct-test-of packages/core/src/steward/reask-once.ts
// @direct-test-of packages/core/src/questions/answer.ts
// @direct-test-of packages/core/src/development/needs-you-decision-builders.ts

import { STEWARD_DECISION_OPTION_IDS as IDS, type StewardAct } from '@forge/contracts/steward';
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

let say: (who: 'owner' | 'steward', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let stewardId = '';
let reqSeq = 900;
let lastRunId = '';
const at = (path: string) => `/api/projects/${projectId}${path}`;

/** Run one stuck diagnosis on `issue` with the scripted turn, and return each tool's answer. */
let diagnose: (
  issue: { id: string; key: string },
  calls: { name: string; args: Record<string, unknown> }[],
  act?: StewardAct,
) => Promise<{ out: { acts: string[]; refused: string[] }; results: string[] }>;

const draftIssue = (seq: number) =>
  createTestIssue(projectId, ownerId, seq, {
    status: 'draft',
    createdAt: new Date(Date.now() - 16 * 86_400_000),
  });

/** A draft its issue-ready record completes: linked, planned against the revision, criteria traced. */
async function readyDraft(seq: number) {
  const issue = await draftIssue(seq);
  reqSeq += 1;
  await completeIssueReadyRecord(projectId, ownerId, issue.id, reqSeq);
  return issue;
}

const decide = (key: string, recommended: string) => ({
  name: 'steward_decide',
  args: { about: key, recommended, why: 'it carries open feedback and nothing else covers it' },
});

const questionsOn = (issueId: string) =>
  rows<{ id: string; status: string; steps: Doc[] }>(sql`
    SELECT id, status, steps FROM agent_questions WHERE issue_id = ${issueId} ORDER BY created_at`);

const statusOf = async (issueId: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${issueId}`))[0]?.status;

const actsOn = (runId: string) =>
  rows<{ id: string; door: string; did: string }>(sql`
    SELECT id, door, did FROM steward_acts WHERE run_id = ${runId} ORDER BY at`);

const answer = (questionId: string, body: Record<string, unknown>) =>
  say('owner', 'POST', `/api/questions/${questionId}/answer`, { round: 1, ...body });

/** Ask the draft's decision, and return the one open question it wrote. */
async function asked(issue: { id: string; key: string }, recommended = 'open') {
  await diagnose(issue, [decide(issue.key, recommended)]);
  const open = (await questionsOn(issue.id)).filter((q) => q.status === 'open');
  expect(open).toHaveLength(1);
  return open[0] as { id: string; status: string; steps: Doc[] };
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const { stewardAccountOf } = await import('../../src/steward/account.js');
  const { mintStewardCredential } = await import('../../src/steward/credential.js');
  stewardId = await stewardAccountOf(projectId);
  const stewardToken = (
    await mintStewardCredential({
      projectId,
      stewardId,
      acts: ['stuck_diagnosis'],
      ttlMs: 30 * 60_000,
    })
  ).token;
  say = requester(app, { owner: await signUserToken(ownerId), steward: stewardToken });
  const { db } = await import('../../src/db/client.js');
  const { stewardRuns } = await import('../../src/db/schema-steward-runs.js');
  const { runGatewayAct } = await import('../../src/steward/turn.js');
  diagnose = async (issue, calls, act = 'stuck_diagnosis') => {
    const [made] = await rows<{ id: string }>(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                                state, not_before, started_at, ended_at)
      VALUES (${projectId}, 'issue', ${issue.id}, ${issue.key}, 'standing.stuck', '[]'::jsonb,
              ARRAY[${act}]::text[], 'done', now(), now(), now())
      RETURNING id`);
    lastRunId = made?.id ?? '';
    const [run] = await db.select().from(stewardRuns).where(eq(stewardRuns.id, lastRunId));
    if (!run) throw new Error('the run row was not written');
    resetScript();
    script.steps = [...calls.map((tool) => ({ tool })), { text: 'Asked.' }];
    const out = await runGatewayAct({ run, act, standing: null, stewardId });
    const results = (script.sent.at(-1) ?? [])
      .filter((m) => m.role === 'tool')
      .map((m) => JSON.stringify(m.content));
    return { out, results };
  };
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe("a stuck issue's question carries Forge's own options (REQ-48 BC-5)", () => {
  it('asks a prepared draft open, keep or drop, recommending open, the model saying only why', async () => {
    const issue = await readyDraft(80);
    const kept = await diagnose(issue, [decide(issue.key, 'keep')]);
    expect(kept.results[0]).toContain('passes the issue-ready check: recommend open');
    expect(await questionsOn(issue.id)).toHaveLength(0);
    const q = await asked(issue);
    const step = q.steps.at(-1) as Doc;
    expect((step.options as Doc[]).map((o) => o.id)).toEqual([IDS.open, IDS.keep, IDS.drop]);
    expect((step.options as Doc[]).map((o) => o.label)).toEqual([
      'Open it: admit it for work',
      'Keep it as a draft',
      'Drop it: it is not work',
    ]);
    expect(step.recommendedOptionId).toBe(IDS.open);
    expect(step.prompt).toContain('Open it, keep it as a draft, or drop it?');
    expect(step.prompt).toContain(
      'Recommended: Open it: admit it for work, because it carries open feedback and nothing else covers it',
    );
    const acts = await actsOn(lastRunId);
    expect(acts).toHaveLength(1);
    expect(acts[0]?.door).toBe(
      `POST /api/projects/${projectId}/steward-runs/${lastRunId}/decisions`,
    );
  });

  it('never asks an unprepared draft open: it names the gaps and the door that prepares it', async () => {
    const issue = await draftIssue(91);
    const { out, results } = await diagnose(issue, [decide(issue.key, 'open')]);
    expect(out).toMatchObject({ acts: [], refused: [] });
    expect(results[0]).toContain(
      'offers link, requirement, drop, merge; recommend one of them, not open',
    );
    expect(results[0]).toContain('steward_prepare_draft');
    expect(await questionsOn(issue.id)).toHaveLength(0);
  });

  it('refuses options the model spells, and a merge that names no live issue', async () => {
    const issue = await draftIssue(81);
    const { out, results } = await diagnose(issue, [
      {
        name: 'steward_decide',
        args: { about: issue.key, recommended: 'merge', why: 'it reads like another one' },
      },
      {
        name: 'steward_ask',
        args: {
          about: issue.key,
          prompt: 'Should we complete the plan and then open it?',
          options: [
            { id: 'complete_admit', label: 'Complete and admit' },
            { id: 'leave', label: 'Leave it' },
          ],
          recommended: 'complete_admit',
        },
      },
    ]);
    expect(out).toMatchObject({ acts: [], refused: [] });
    // merge is offered a draft only into a live issue the turn names
    expect(results[0]).toContain('recommending merge names the live item it repeats in `into`');
    // a free-form ask is no door of a diagnosis: its menu holds the decision alone
    expect(results[1]).toContain('steward_ask is not a door of stuck_diagnosis');
    expect(await questionsOn(issue.id)).toHaveLength(0);
  });

  it('keeps a free-form question to a requirement, never an issue or a feedback item', async () => {
    const issue = await draftIssue(90);
    const ask = (about: string) => ({
      name: 'steward_ask',
      args: {
        about,
        prompt: 'Which board does BC-1 mean, saved or shared?',
        options: [
          { id: 'a', label: 'Saved' },
          { id: 'b', label: 'Shared' },
        ],
        recommended: 'a',
      },
    });
    const { out, results } = await diagnose(issue, [ask(issue.key), ask('FB-3')], 'intake_check');
    expect(out).toMatchObject({ acts: [], refused: [] });
    expect(results[0]).toContain('a question about an issue is a decision');
    // a feedback item's question is its decision, which steward_decide asks with Forge's options
    expect(results[1]).toContain('FB-3 is a feedback item: its question is a decision');
    expect(results[1]).toContain('steward_decide about FB-3');
  });

  it("asks nothing where the wait is somebody's act already, or the same question is open", async () => {
    const waiting = await createTestIssue(projectId, ownerId, 82, {
      status: 'needs_info',
      createdAt: new Date(),
      waitingKind: 'needs_decision',
    });
    const draft = await readyDraft(83);
    await asked(draft);
    const { out, results } = await diagnose(waiting, [
      decide(waiting.key, 'keep'),
      decide(draft.key, 'open'),
    ]);
    // a decision nobody owes is the turn's to correct, never a refusal on the run
    expect(out).toMatchObject({ acts: [], refused: [] });
    expect(results[0]).toContain(`${waiting.key} is needs_info`);
    expect(results[0]).toContain('Ask nothing');
    expect(results[1]).toContain('already asks it');
    expect(await questionsOn(waiting.id)).toHaveLength(0);
    expect(await questionsOn(draft.id)).toHaveLength(1);
  });
});

describe('answering a steward decision carries it out as the answerer (REQ-48 BC-5)', () => {
  it('opens a ready draft through the kernel as the answerer, and logs the act on the item', async () => {
    const issue = await readyDraft(84);
    const q = await asked(issue);
    const done = await answer(q.id, { optionId: IDS.open });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(await statusOf(issue.id)).toBe('open');
    const [move] = await rows<{ actor_id: string; reason: string }>(sql`
      SELECT actor_id, reason FROM kernel_transitions
       WHERE entity = 'issue' AND entity_id = ${issue.id} AND to_status = 'open'`);
    expect(move?.actor_id).toBe(ownerId);
    expect(move?.reason).toContain(`the steward's question ${q.id}`);
    expect((await questionsOn(issue.id))[0]?.status).toBe('answered');
    const acts = await actsOn(lastRunId);
    expect(acts.map((a) => a.door)).toEqual([
      `POST /api/projects/${projectId}/steward-runs/${lastRunId}/decisions`,
      `POST /api/issues/${issue.id}/transition`,
    ]);
    expect(acts[1]?.did).toContain(`Opened ${issue.key} on the answer`);
  });

  it("refuses an open the kernel's ready check refuses, by its name, and leaves the question open", async () => {
    const issue = await readyDraft(85);
    const q = await asked(issue);
    // the draft loses its plan revision between the question and its answer
    await rows(sql`UPDATE issues SET planned_revision = NULL WHERE id = ${issue.id} RETURNING id`);
    const refused = await answer(q.id, { optionId: IDS.open });
    expect([refused.status, refused.json.code]).toEqual([422, 'CHECKLIST_INCOMPLETE']);
    expect(await statusOf(issue.id)).toBe('draft');
    expect((await questionsOn(issue.id))[0]?.status).toBe('open');
    expect(await actsOn(lastRunId)).toHaveLength(1);
  });

  it('drops it with the reason given, and refuses a drop that gives none', async () => {
    const issue = await draftIssue(86);
    const q = await asked(issue, 'drop');
    const bare = await answer(q.id, { optionId: IDS.drop });
    expect([bare.status, bare.json.code]).toEqual([422, 'STEWARD_DECISION_REASON_REQUIRED']);
    expect(await statusOf(issue.id)).toBe('draft');
    const done = await answer(q.id, { optionId: IDS.drop, note: 'FB-12 was declined; no work.' });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(await statusOf(issue.id)).toBe('dropped');
    const [move] = await rows<{ reason: string }>(sql`
      SELECT reason FROM kernel_transitions
       WHERE entity = 'issue' AND entity_id = ${issue.id} AND to_status = 'dropped'`);
    expect(move?.reason).toContain('FB-12 was declined; no work.');
  });

  it('keeps it with the reason, and the same question is not asked again on that standing', async () => {
    const issue = await readyDraft(87);
    const q = await asked(issue);
    const askRun = lastRunId;
    const done = await answer(q.id, { optionId: IDS.keep, note: 'Until REQ-50 is agreed.' });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(await statusOf(issue.id)).toBe('draft');
    const acts = await actsOn(askRun);
    expect(acts.map((a) => a.door)).toEqual([
      `POST /api/projects/${projectId}/steward-runs/${askRun}/decisions`,
      `KEEP ${issue.key}`,
    ]);
    expect(acts[1]?.did).toContain('Until REQ-50 is agreed.');
    const again = await diagnose(issue, [decide(issue.key, 'open')]);
    expect(again.results[0]).toContain('was kept on the standing it reads now');
    expect(await questionsOn(issue.id)).toHaveLength(1);
    // the keep is undone like any steward act: refused naming how a person overrides it
    const undo = await say('owner', 'POST', at(`/steward-acts/${acts[1]?.id}/undo`), {});
    expect([undo.status, undo.json.code]).toEqual([422, 'STEWARD_ACT_NOT_UNDOABLE']);
    expect(JSON.stringify(undo.json)).toContain('a keep moved nothing');
  });

  it("shows in Needs you as the steward's, each button saying what it does, keep and drop asking why", async () => {
    const issue = await readyDraft(88);
    const q = await asked(issue);
    const read = ok(await say('owner', 'GET', at('/needs-you/decisions')));
    const decision = (read.decisions as Doc[]).find((d) => d.key === issue.key);
    if (!decision) throw new Error(`${issue.key} is not in Needs you`);
    expect(decision.recommended).toMatchObject({ answerId: IDS.open, by: 'steward' });
    expect((decision.recommended as Doc).why).toContain('because it carries open feedback');
    const answers = decision.answers as Doc[];
    expect(answers.map((a) => [a.id, a.needsReason])).toEqual([
      [IDS.open, false],
      [IDS.keep, true],
      [IDS.drop, true],
    ]);
    // each button says what it does to this issue, never that it sends the answer to a run
    expect(answers.map((a) => a.effect)).toEqual([
      `Opens ${issue.key} as you; its driver plans it from the requirement, plan and criteria the steward prepared.`,
      `Keeps ${issue.key} as a draft until its standing moves, with your reason; the steward does not ask again until then.`,
      `Drops ${issue.key} as you, with your reason.`,
    ]);
    expect(answers[0]?.path).toBe(`/api/questions/${q.id}/answer`);
  });
});

describe('the one-off voids the questions the steward spelled, and diagnoses their items again', () => {
  it('voids each free-form question once, and a second boot does nothing', async () => {
    const issue = await draftIssue(89);
    await diagnose(issue, []);
    const runId = lastRunId;
    const made = ok(
      await say('steward', 'POST', '/api/questions', {
        issueId: issue.id,
        prompt: 'ISS-89 has been a draft for 16 days. Should we complete it and admit it?',
        options: ['complete_admit', 'keep_draft'].map((id) => ({
          id,
          label: id,
          authority: 'writer',
          bindsTo: 'this_call',
          executedBy: 'human',
          fingerprint: `steward:${runId}:${id}`,
        })),
        recommendedOptionId: 'complete_admit',
        blockerKind: 'human',
      }),
      201,
    );
    const { runStewardReaskOnce } = await import('../../src/steward/reask-once.js');
    const report = await runStewardReaskOnce();
    expect(report?.refusals).toEqual([]);
    expect(report?.voided).toBeGreaterThanOrEqual(1);
    const [voided] = await rows<{ status: string; void_reason: string; updated_at: string }>(sql`
      SELECT status, void_reason, updated_at::text FROM agent_questions WHERE id = ${made.id as string}`);
    expect(voided?.status).toBe('void');
    expect(voided?.void_reason).toContain("Forge's own options");
    // its item, still stuck, is diagnosed again, emitted before the void so a stop between loses nothing
    const emitted = await rows<{ created_at: string }>(sql`
      SELECT created_at::text FROM pipeline_outbox
       WHERE type = 'standing.stuck' AND payload -> 'subject' ->> 'id' = ${issue.id}`);
    expect(emitted).toHaveLength(1);
    expect(report?.reasked).toBeGreaterThanOrEqual(1);
    expect(new Date(emitted[0]?.created_at ?? '').getTime()).toBeLessThanOrEqual(
      new Date(voided?.updated_at ?? '').getTime(),
    );
    await settleOutbox();
    expect(await runStewardReaskOnce()).toBeNull();
  });
});
