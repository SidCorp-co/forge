import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { namespaceFromServerUrl } from '../../src/integrations/rocketchat/namespace.js';
import { api, userToken } from '../helpers/api.js';
import { createTestIssue, rows } from '../helpers/factories.js';
import { AgentWorld, OWNER_ID } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/owner-ask.ts
//
// ISS-871: a master's question to the owner goes through the channel, as the switched hand bot's
// did. The master asks in Forge (POST /api/questions); the channel agent asks the owner in a thread
// naming that question; the owner's next message there is recorded as the question's answer, as the
// owner's linked Forge account, through the questions door that wakes the master who asked. A
// question that cannot take it is refused when asked; an answer that cannot be recorded is kept as a
// refusal and told to the agent, and the question stays open.

const w = new AgentWorld();
let chat: StandInRocketChat;
let owner = '';
let seq = 100;

/** A master's open question on an issue in progress: yes or no. */
async function masterAsks(prompt: string): Promise<string> {
  const issue = await createTestIssue(w.projectId, w.ownerId, ++seq, {
    status: 'in_progress',
    createdAt: new Date(),
  });
  const asked = await api(owner, 'POST', '/api/questions', {
    issueId: issue.id,
    prompt,
    options: [
      { id: 'yes', label: 'Yes', authority: 'writer', bindsTo: 'project', executedBy: 'agent' },
      { id: 'no', label: 'No', authority: 'writer', bindsTo: 'project', executedBy: 'agent' },
    ],
    recommendedOptionId: 'yes',
  });
  expect(asked.status, JSON.stringify(asked.body)).toBe(201);
  return String(asked.body.id);
}

const question = async (id: string) =>
  (
    await rows<{ status: string; steps: { chosenOptionId?: string; answeredBy?: string }[] }>(
      sql`SELECT status, steps FROM agent_questions WHERE id = ${id}::uuid`,
    )
  )[0];

/** The agent asks the owner in a new thread, naming `forgeQuestion`; the thread and the act's answer. */
async function agentAsks(forgeQuestion: string, text: string) {
  let out: Record<string, unknown> = {};
  const thread = await w.hear(
    () => chat.say(chat.bob, text),
    async (_t, act, message) => {
      out = await act({
        action: 'ask_owner',
        thread: message().thread,
        question: 'The AdminHub master asks: may it resend PO 1453 to the supplier now?',
        forgeQuestion,
      });
    },
  );
  return { thread: thread.id, out };
}

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  owner = await userToken(w.ownerId);
}, 120_000);

afterAll(() => w.stop());

describe("ISS-871: a master's question asked of the owner through the channel", () => {
  it('refuses, asking nothing, a question that is no open question of this project', async () => {
    // the owner has written here before, so the question can name them
    await w.hear(() => chat.say(chat.alice, 'morning all'));
    const answered = await masterAsks('Already decided?');
    const done = await api(owner, 'POST', `/api/questions/${answered}/answer`, {
      round: 1,
      optionId: 'no',
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const outs: Record<string, Record<string, unknown>> = {};
    await w.hear(
      () => chat.say(chat.bob, 'the master has a question for the owner'),
      async (_t, act, message) => {
        const before = chat.linesIn(chat.rid).length;
        for (const [k, id] of [
          ['unknown', '00000000-0000-4000-8000-000000000999'],
          ['answered', answered],
        ] as const) {
          outs[k] = await act({
            action: 'ask_owner',
            thread: message().thread,
            question: 'May the master go ahead?',
            forgeQuestion: id,
          });
        }
        outs.shape = await act({
          action: 'ask_owner',
          thread: message().thread,
          question: 'May the master go ahead?',
          forgeQuestion: 'Q-12',
        });
        expect(chat.linesIn(chat.rid).length).toBe(before);
      },
    );
    expect(code(outs.unknown)).toBe('SUPPORT_OWNER_QUESTION_UNKNOWN');
    expect(JSON.stringify(outs.unknown)).toContain(
      'names no question of the projects this agent follows',
    );
    expect(code(outs.answered)).toBe('SUPPORT_OWNER_QUESTION_UNKNOWN');
    expect(JSON.stringify(outs.answered)).toContain('is answered, and only an open one');
    expect(outs.shape?.isError, JSON.stringify(outs.shape)).toBe(true);
  });

  it('keeps the answer of an owner linked to no Forge account, tells the agent who owes the setup, and leaves the question open', async () => {
    const id = await masterAsks('Resend PO 1453 now?');
    const { thread, out } = await agentAsks(id, 'can the master resend PO 1453?');
    expect(out, JSON.stringify(out)).toMatchObject({ isError: false, forgeQuestion: id });
    const answer = await w.hear(() => chat.say(chat.alice, 'yes', thread));
    expect(answer.message.answersYourQuestion).toContain('may it resend PO 1453');
    await expect
      .poll(async () =>
        rows<{ output: { why?: string } }>(sql`
          SELECT output FROM support_actions
           WHERE project_id = ${w.projectId}::uuid AND thread = ${thread} AND kind = 'refused'
             AND tool = 'owner_answer'`),
      )
      .toHaveLength(1);
    expect((await question(id))?.status).toBe('open');
    const told = answer.turn.messages.find((m) => m.from === 'forge' && m.text.includes(id));
    // ISS-976: the answer is kept to record once his account is named, and the agent never asks him
    expect(told?.text).toContain('no Forge account yet');
    expect(told?.text).toContain('noted and waits on a setup step its admins own');
    expect(told?.text).not.toContain('ask them to link');
    const kept = await rows<{ input: { questionId: string; message: string } }>(sql`
      SELECT input FROM support_actions WHERE kind = 'answer_kept' AND input ->> 'questionId' = ${id}`);
    expect(kept.map((k) => k.input.message)).toEqual([answer.id]);
  });

  it("records the linked owner's answer on the question, as the owner, and the master's wait ends", async () => {
    await db.execute(sql`
      INSERT INTO assistant_speaker_links (source, external_namespace, external_id, user_id, confirmed_via)
      VALUES ('rocketchat', ${namespaceFromServerUrl(chat.serverUrl)}, ${OWNER_ID}, ${w.ownerId}, 'channel_email_match')`);
    const id = await masterAsks('Resend PO 1460 now?');
    const { thread } = await agentAsks(id, 'can the master resend PO 1460?');
    // words naming none of a choice's options are not guessed into one
    await w.hear(() => chat.say(chat.alice, 'hmm, maybe later', thread));
    expect((await question(id))?.status).toBe('open');
    // the owner's next message in the thread is the answer: a fresh ask, then the plain option
    const again = await agentAsks(id, 'once more: can the master resend PO 1460?');
    await w.hear(() => chat.say(chat.alice, 'Yes', again.thread));
    await expect.poll(async () => (await question(id))?.status).toBe('answered');
    expect((await question(id))?.steps.at(-1)).toMatchObject({
      chosenOptionId: 'yes',
      answeredBy: w.ownerId,
    });
  });
});
