// REQ-41 BC-25, BC-27 and BC-24 against the real Needs-you read, the real answer route and the real
// kernel: the chat makes the drafts' steward decisions the person agreed, on their word, as them; an
// item they already moved is named done with who and when; and a card pressed under a reply is
// answered in the room with the item read back. A draft's decision is asked on the requirement it
// delivers (REQ-68 BC-4), so the person names it by that item, and the card opens it, never the issue.
// ISS-624 (judge K66 on dev.304): the set the person agreed is the one core kept, acted on whole; a
// failed press is answered with its refusal; and a decision refused twice is filed into Forge's own
// feedback and not offered again.
//
// @direct-test-of packages/core/src/assistant/tools/decide-tool.ts
// @direct-test-of packages/core/src/assistant/item-state.ts
// @direct-test-of packages/core/src/assistant/decision-outcome-routes.ts
// @direct-test-of packages/core/src/assistant/decision-outcome.ts
// @direct-test-of packages/core/src/assistant/decision-acts.ts
// @direct-test-of packages/core/src/assistant/tools/needs-you-withheld.ts

import { randomUUID } from 'node:crypto';
import { STEWARD_DECISION_OPTION_IDS as IDS } from '@forge/contracts/steward';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
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
import { underStrict } from '../helpers/project-controls.js';
import { resetScript, script } from '../helpers/scripted-chat.js';

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/llm/chat.js')>()),
  openChat: (await import('../helpers/scripted-chat.js')).scriptedOpenChat,
}));

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let reqSeq = 900;
let ask: (issue: { id: string; key: string }) => Promise<void>;
/** The room the chat answers in: where a set is kept and a refused act counted. */
let roomId = '';

/**
 * A draft its issue-ready record completes, sixteen days old so the steward finds it stuck, with the
 * requirement it delivers: the item its decision is asked on.
 */
async function readyDraft(seq: number) {
  const issue = await createTestIssue(projectId, ownerId, seq, {
    status: 'draft',
    createdAt: new Date(Date.now() - 16 * 86_400_000),
  });
  reqSeq += 1;
  await completeIssueReadyRecord(projectId, ownerId, issue.id, reqSeq);
  return { ...issue, req: `REQ-${reqSeq}` };
}

const questionsOn = (issueId: string) =>
  rows<{ id: string; status: string }>(sql`
    SELECT id, status FROM agent_questions WHERE issue_id = ${issueId} ORDER BY created_at`);

const statusOf = async (issueId: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${issueId}`))[0]?.status;

const answer = (questionId: string, body: Record<string, unknown>) =>
  say('owner', 'POST', `/api/questions/${questionId}/answer`, { round: 1, ...body });

/** The steward asks the draft open, keep or drop, recommending open; the one open question it wrote. */
async function asked(issue: { id: string; key: string }) {
  await ask(issue);
  const open = (await questionsOn(issue.id)).filter((q) => q.status === 'open');
  expect(open).toHaveLength(1);
  return open[0] as { id: string; status: string };
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const { stewardAccountOf } = await import('../../src/steward/account.js');
  const stewardId = await stewardAccountOf(projectId);
  say = requester(app, { owner: await signUserToken(ownerId) });
  const { db } = await import('../../src/db/client.js');
  const { stewardRuns } = await import('../../src/db/schema-steward-runs.js');
  const { runGatewayAct } = await import('../../src/steward/turn.js');
  ask = async (issue) => {
    const [made] = await rows<{ id: string }>(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                                state, not_before, started_at, ended_at)
      VALUES (${projectId}, 'issue', ${issue.id}, ${issue.key}, 'standing.stuck', '[]'::jsonb,
              ARRAY['stuck_diagnosis']::text[], 'done', now(), now(), now())
      RETURNING id`);
    const [run] = await db
      .select()
      .from(stewardRuns)
      .where(eq(stewardRuns.id, made?.id ?? ''));
    if (!run) throw new Error('the run row was not written');
    resetScript();
    script.steps = [
      {
        tool: {
          name: 'steward_decide',
          args: {
            about: issue.key,
            recommended: 'open',
            why: 'it has a requirement, a plan and criteria',
            serious: true,
          },
        },
      },
      { text: 'Asked.' },
    ];
    // the person's Needs you holds it: serious, asked on a strict project (REQ-79 BC-13)
    await underStrict(projectId, ownerId, () =>
      runGatewayAct({ run, act: 'stuck_diagnosis', standing: null, stewardId }),
    );
  };
}, 120_000);

beforeAll(async () => {
  roomId = String(
    ok(await say('owner', 'POST', '/api/conversations', { projectId, title: 'needs you' }), 201).id,
  );
  // the room's first turn answered about the project: its cards were read there
  await rows(sql`
    INSERT INTO conversation_windows (conversation_id, project_id, adapter, first_seq, last_seq)
    VALUES (${roomId}, ${projectId}, 'web', 1, 1)`);
});

afterAll(async () => {
  await closeWorld();
});

const decideTools = async (latest: string, windowId: string) => {
  const { buildDecideToolset } = await import('../../src/assistant/tools/decide-tool.js');
  return buildDecideToolset({
    projectId,
    userId: ownerId,
    conversationId: roomId,
    windowId,
    latestMessage: () => latest,
  });
};

/** A call of the decide toolset in turn `windowId`, as the chat makes it. */
const decide = async (tool: string, latest: string, args: unknown, windowId = randomUUID()) => {
  const r = await (await decideTools(latest, windowId)).execute(tool, JSON.stringify(args));
  return {
    isError: r.isError === true,
    body: JSON.parse((r.content[0] as { text: string }).text) as Doc,
  };
};

// REQ-41 BC-25, BC-27, BC-24, dev 2026-10-22 (conversation a760cd5f): the owner agreed a cluster of
// drafts, opened three of them by hand at 07:48, then said "Tôi bảo là mở giúp tôi đi" and was told
// "I cannot press approval for you". The tool runs here against the real Needs-you read, the real
// answer route and the real kernel. // i18n-allow: the owner's word quoted
describe("the chat makes the agreed decisions on the person's word, as them (REQ-41 BC-25, BC-27, BC-24)", () => {
  const LATEST = 'Tôi bảo là mở giúp tôi đi'; // i18n-allow: the owner's word on dev
  const WORD = 'mở giúp tôi đi'; // i18n-allow: the owner's word on dev
  const call = (latest: string, args: unknown) => decide('act_on_decisions', latest, args);

  it('refuses the earlier message as the word, and leaves every draft and its decision as it was', async () => {
    const issue = await readyDraft(194);
    const q = await asked(issue);
    const { isError, body } = await call(LATEST, {
      word: 'Ok mở cho tôi cụm đó đi', // i18n-allow: the owner's earlier message
      decisions: [{ decision: issue.key }],
    });
    expect(isError).toBe(true);
    expect(String(body.error)).toMatch(/^CHAT_DECIDE_NO_WORD: /);
    expect(await statusOf(issue.id)).toBe('draft');
    expect((await questionsOn(issue.id)).find((x) => x.id === q.id)?.status).toBe('open');
  });

  it('opens the agreed drafts as the owner by the requirement each is asked on, names the one opened by hand done, and reads each back', async () => {
    const a = await readyDraft(195);
    const b = await readyDraft(196);
    const byHand = await readyDraft(197);
    await asked(a);
    await asked(b);
    await asked(byHand);
    // the person names what they see: the requirement each decision is asked on, never the issue
    const put = await decide('put_decision_set', 'which drafts are ready?', {
      decisions: [{ decision: byHand.req }, { decision: a.req }, { decision: b.req }],
    });
    expect(put.isError, JSON.stringify(put.body)).toBe(false);
    expect((put.body.items as Doc[]).map((i) => i.key)).toEqual([byHand.req, a.req, b.req]);
    ok(await say('owner', 'POST', `/api/issues/${byHand.id}/transition`, { toStatus: 'open' }));
    const [move] = await rows<{ actor_id: string }>(sql`
      SELECT actor_id FROM kernel_transitions WHERE entity = 'issue' AND entity_id = ${byHand.id}
       ORDER BY created_at DESC LIMIT 1`);
    expect(move?.actor_id).toBe(ownerId);
    // their next message agrees it: the set core kept is made whole, and nothing else
    const { isError, body } = await call(LATEST, { word: WORD, set: put.body.set });
    expect(isError, JSON.stringify(body)).toBe(false);
    const results = body.results as Doc[];
    // its decision left Needs you when the draft moved (REQ-68 BC-7): the item reads back as it is
    expect(results[0]).toMatchObject({
      outcome: 'already_done',
      // read as it is, never as meant: the requirement itself has not moved
      state: { key: byHand.req, status: 'agreed', movedBy: null, movedAt: null },
    });
    for (const [i, issue] of [a, b].entries()) {
      expect(results[i + 1]).toMatchObject({
        outcome: 'done',
        answer: expect.stringContaining('Open'),
        state: { key: issue.req, status: 'agreed', movedBy: null, movedAt: null },
      });
      expect(await statusOf(issue.id)).toBe('open');
      const [moved] = await rows<{ actor_id: string; from_status: string }>(sql`
        SELECT actor_id, from_status FROM kernel_transitions WHERE entity = 'issue' AND entity_id = ${issue.id}
         ORDER BY created_at DESC LIMIT 1`);
      expect(moved, 'the kernel recorded the move as the owner, not the assistant').toEqual({
        actor_id: ownerId,
        from_status: 'draft',
      });
    }
  });

  it('answers a card pressed under the reply in the room, with the item read back', async () => {
    const issue = await readyDraft(198);
    const q = await asked(issue);
    ok(await answer(q.id, { optionId: IDS.open }));
    const fresh = String(
      ok(await say('owner', 'POST', '/api/conversations', { projectId, title: 'fresh' }), 201).id,
    );
    const outcome = (body: Doc, room = roomId) =>
      say('owner', 'POST', `/api/conversations/${room}/decision-outcomes`, body);
    const pressed = {
      decision: `question:${q.id}:question.answer`,
      key: issue.req,
      opens: { kind: 'requirement', key: issue.req },
      ok: true,
    };

    const early = await outcome(pressed, fresh);
    expect([early.status, early.json.code]).toEqual([422, 'DECISION_OUTCOME_NO_PROJECT']);

    const told = ok(await outcome(pressed));
    // the requirement is read back as it is: agreed, with no move recorded since its seeding
    expect(told.content).toBe(`Your answer on ${issue.req} was sent. ${issue.req} is agreed.`);
    const [said] = await rows<{ role: string; content: string }>(sql`
      SELECT role, content FROM conversation_messages WHERE conversation_id = ${roomId} ORDER BY seq DESC LIMIT 1`);
    expect(said).toEqual({ role: 'assistant', content: told.content });

    expect(await statusOf(issue.id), 'the answer opened the draft').toBe('open');

    const bad = await outcome({ ...pressed, opens: { kind: 'requirement', key: 'REQ-1 OR 1=1' } });
    expect(bad.status).toBe(400);
    // a card opens a product item, never an issue (REQ-68 BC-6)
    const onIssue = await outcome({ ...pressed, opens: { kind: 'issue', key: issue.key } });
    expect(onIssue.status).toBe(400);
    const stranger = await outcome({ ...pressed, ok: false, extra: 'Done: everything' });
    expect(stranger.status).toBe(400);
    // a failed press carries why, or it is not one (ISS-624)
    const noWhy = await outcome({ ...pressed, ok: false });
    expect(noWhy.status).toBe(400);
  });
});

// ISS-624, judge K66 on dev.304 (REQ-41 BC-24, BC-25, BC-28), against the real read, route and kernel.
describe('the agreed set is core’s, a failed press says why, and a decision refused twice is filed (ISS-624)', () => {
  const LATEST = 'ok, open them';

  it('acts on exactly the set put in an earlier turn, and refuses a decision the message does not name', async () => {
    const agreed = await readyDraft(301);
    const other = await readyDraft(302);
    await asked(agreed);
    await asked(other);
    const turn = randomUUID();
    const put = await decide(
      'put_decision_set',
      'which?',
      { decisions: [{ decision: agreed.req }] },
      turn,
    );
    const same = await decide(
      'act_on_decisions',
      LATEST,
      { word: LATEST, set: put.body.set },
      turn,
    );
    // a set is acted on in a later turn only: the person has not seen it in this one
    expect(String(same.body.error)).toMatch(/^CHAT_DECIDE_SET_UNSEEN: /);
    const widened = await decide('act_on_decisions', LATEST, {
      word: LATEST,
      decisions: [{ decision: other.req }],
    });
    expect((widened.body.results as Doc[])[0]).toMatchObject({ code: 'DECISION_NOT_AGREED' });
    const made = await decide('act_on_decisions', LATEST, { word: LATEST, set: put.body.set });
    expect((made.body.results as Doc[]).map((r) => r.outcome)).toEqual(['done']);
    expect(await statusOf(agreed.id)).toBe('open');
    expect(await statusOf(other.id), 'never agreed, never opened').toBe('draft');
  });

  it('answers a failed press with its refusal; the second files it in Forge feedback and it is withheld', async () => {
    const home = await createTestProject(ownerId);
    await rows(sql`
      INSERT INTO instance_settings (id, forge_home_project_id, revision, updated_by)
      VALUES (1, ${home.id}, 1, ${ownerId})
      ON CONFLICT (id) DO UPDATE SET forge_home_project_id = EXCLUDED.forge_home_project_id`);
    const issue = await readyDraft(303);
    const q = await asked(issue);
    const read = async () =>
      ok(await say('owner', 'GET', `/api/projects/${projectId}/needs-you/decisions`)) as Doc;
    const decision = ((await read()).decisions as Doc[]).find(
      (d) => d.opens?.key === issue.req,
    ) as Doc;
    const rowKey = String(decision.key);
    expect(decision.id).toBe(`question:${q.id}`);
    const failed = {
      decision: decision.id,
      key: rowKey,
      opens: { kind: 'requirement', key: issue.req },
      ok: false,
      failure: { code: 'QUESTION_ROUND_STALE', detail: 'round 1 was answered; round 2 is open' },
    };
    const press = () =>
      say('owner', 'POST', `/api/conversations/${roomId}/decision-outcomes`, failed);

    const first = ok(await press());
    expect(first.content).toBe(
      `Your answer on ${issue.req} did not go through. Forge refused it: QUESTION_ROUND_STALE: round 1 was answered; round 2 is open. The decision still waits on you: press the card again once that is fixed, or decide it on its own page. ${issue.req} is agreed.`,
    );
    const second = ok(await press());
    expect(second.content).toMatch(
      /It was refused twice here, so Forge recorded it in its own feedback as FB-\d+ and the chat will not offer it again/,
    );
    const [filed] = await rows<{ title: string; signal_key: string }>(sql`
      SELECT title, signal_key FROM feedback WHERE project_id = ${home.id} ORDER BY fb_seq DESC LIMIT 1`);
    expect(filed).toEqual({
      title: `The chat's decision on ${rowKey} was refused each time it was acted on`,
      signal_key: 'chat:refused-twice:decision:QUESTION_ROUND_STALE',
    });

    // the chat's read of what waits on the person leaves it out, naming why; no card is drawn
    const { withoutRefusedTwice } = await import('../../src/assistant/tools/needs-you-withheld.js');
    const { needsYouDecisionsSchema } = await import('@forge/contracts/needs-you-decisions');
    const plain = needsYouDecisionsSchema.parse(await read());
    const shown = await withoutRefusedTwice(plain, roomId);
    expect(shown.decisions.map((d) => d.id)).not.toContain(decision.id);
    expect(shown.total).toBe(plain.total - 1);
    expect(shown.withheld?.map((w) => [w.key, /FB-\d+/.test(w.why)])).toEqual([[rowKey, true]]);

    // and the chat may neither put it in a set nor make it a third time
    const put = await decide('put_decision_set', 'which?', {
      decisions: [{ decision: issue.req }],
    });
    expect(String(put.body.error)).toContain('DECISION_REFUSED_TWICE');
    const third = await decide('act_on_decisions', `open ${issue.req}`, {
      word: `open ${issue.req}`,
      decisions: [{ decision: issue.req }],
    });
    expect((third.body.results as Doc[])[0]).toMatchObject({ code: 'DECISION_REFUSED_TWICE' });
    expect(await statusOf(issue.id)).toBe('draft');
  });
});
