// REQ-41 BC-25, BC-27 and BC-24 against the real Needs-you read, the real answer route and the real
// kernel: the chat makes the drafts' steward decisions the person agreed, on their word, as them; an
// item they already moved is named done with who and when; and a card pressed under a reply is
// answered in the room with the item read back.
//
// @direct-test-of packages/core/src/assistant/tools/decide-tool.ts
// @direct-test-of packages/core/src/assistant/item-state.ts
// @direct-test-of packages/core/src/assistant/decision-outcome-routes.ts
// @direct-test-of packages/core/src/assistant/decision-outcome.ts

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

/** A draft its issue-ready record completes, sixteen days old so the steward finds it stuck. */
async function readyDraft(seq: number) {
  const issue = await createTestIssue(projectId, ownerId, seq, {
    status: 'draft',
    createdAt: new Date(Date.now() - 16 * 86_400_000),
  });
  reqSeq += 1;
  await completeIssueReadyRecord(projectId, ownerId, issue.id, reqSeq);
  return issue;
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
          },
        },
      },
      { text: 'Asked.' },
    ];
    await runGatewayAct({ run, act: 'stuck_diagnosis', standing: null, stewardId });
  };
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

// REQ-41 BC-25, BC-27, BC-24, dev 2026-10-22 (conversation a760cd5f): the owner agreed a cluster of
// drafts, opened three of them by hand at 07:48, then said "Tôi bảo là mở giúp tôi đi" and was told
// "I cannot press approval for you". The tool runs here against the real Needs-you read, the real
// answer route and the real kernel. // i18n-allow: the owner's word quoted
describe("the chat makes the agreed decisions on the person's word, as them (REQ-41 BC-25, BC-27, BC-24)", () => {
  const LATEST = 'Tôi bảo là mở giúp tôi đi'; // i18n-allow: the owner's word on dev
  const WORD = 'mở giúp tôi đi'; // i18n-allow: the owner's word on dev
  const toolset = async (latest: string) => {
    const { buildDecideToolset } = await import('../../src/assistant/tools/decide-tool.js');
    return buildDecideToolset({ projectId, userId: ownerId, latestMessage: () => latest });
  };
  const call = async (latest: string, args: unknown) => {
    const r = await (await toolset(latest)).execute('act_on_decisions', JSON.stringify(args));
    return {
      isError: r.isError === true,
      body: JSON.parse((r.content[0] as { text: string }).text) as Doc,
    };
  };
  const ownerName = async () => {
    const { userNames } = await import('../../src/lib/people.js');
    return (await userNames([ownerId])).get(ownerId) ?? null;
  };

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

  it('opens the agreed drafts as the owner, names the one they opened by hand done with who and when, and reads each back', async () => {
    const a = await readyDraft(195);
    const b = await readyDraft(196);
    const byHand = await readyDraft(197);
    await asked(a);
    await asked(b);
    await asked(byHand);
    ok(await say('owner', 'POST', `/api/issues/${byHand.id}/transition`, { toStatus: 'open' }));
    const [move] = await rows<{ created_at: Date }>(sql`
      SELECT created_at FROM kernel_transitions WHERE entity = 'issue' AND entity_id = ${byHand.id}
       ORDER BY created_at DESC LIMIT 1`);

    const { isError, body } = await call(LATEST, {
      word: WORD,
      decisions: [{ decision: byHand.key }, { decision: a.key }, { decision: b.key }],
    });
    expect(isError, JSON.stringify(body)).toBe(false);
    const name = await ownerName();
    const results = body.results as Doc[];
    expect(results[0]).toEqual({
      outcome: 'already_done',
      decision: byHand.key,
      state: {
        key: byHand.key,
        status: 'open',
        movedBy: name,
        movedAt: new Date(String(move?.created_at)).toISOString(),
      },
    });
    for (const [i, issue] of [a, b].entries()) {
      expect(results[i + 1]).toMatchObject({
        outcome: 'done',
        decision: issue.key,
        answer: expect.stringContaining('Open'),
        state: { key: issue.key, status: 'open', movedBy: name },
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
    const room = ok(
      await say('owner', 'POST', '/api/conversations', { projectId, title: 'needs you' }),
      201,
    );
    const roomId = String(room.id);
    const outcome = (body: Doc) =>
      say('owner', 'POST', `/api/conversations/${roomId}/decision-outcomes`, body);
    const pressed = {
      decision: `issue:${issue.key}:question.answer`,
      opens: { kind: 'issue', key: issue.key },
      ok: true,
    };

    const early = await outcome(pressed);
    expect([early.status, early.json.code]).toEqual([422, 'DECISION_OUTCOME_NO_PROJECT']);

    await rows(sql`
      INSERT INTO conversation_windows (conversation_id, project_id, adapter, first_seq, last_seq)
      VALUES (${roomId}, ${projectId}, 'web', 1, 1)`);
    const told = ok(await outcome(pressed));
    expect(told.content).toMatch(
      new RegExp(
        `^Your answer on ${issue.key} was sent\\. ${issue.key} is open; last moved by .+ at \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC\\.$`,
      ),
    );
    const [said] = await rows<{ role: string; content: string }>(sql`
      SELECT role, content FROM conversation_messages WHERE conversation_id = ${roomId} ORDER BY seq DESC LIMIT 1`);
    expect(said).toEqual({ role: 'assistant', content: told.content });

    const bad = await outcome({ ...pressed, opens: { kind: 'issue', key: 'ISS-1 OR 1=1' } });
    expect(bad.status).toBe(400);
    const stranger = await outcome({ ...pressed, ok: false, extra: 'Done: everything' });
    expect(stranger.status).toBe(400);
  });
});
