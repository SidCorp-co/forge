import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { settleOwnerAnswer } from '../../src/support/owner-answer.js';
import { insertAction } from '../../src/support/store.js';
import { rows } from '../helpers/factories.js';
import { AgentWorld, agentBlock, OWNER_ID } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/owner-ask.ts
// @direct-test-of packages/core/src/support/technical-channel.ts
// @direct-test-of packages/core/src/support/owner-answer.ts
// @direct-test-of packages/core/src/support/inbound.ts
// @direct-test-of packages/core/src/integrations/rocketchat/connection-manager.ts
//
// REQ-77 BC-12, ISS-1246: a channel agent asks the owner through the project's technical channel
// alone, and his reply there, by the chat server's word on who wrote it, reaches the asking session
// and the issue it named. The world is support-agent-world's.

const w = new AgentWorld();
let chat: StandInRocketChat;
/** The project's technical channel: by default a direct message to the owner the binding names. */
const DM = 'D-alice';

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
}, 120_000);

afterAll(() => w.stop());

describe('REQ-77 BC-12, ISS-1246: an agent asks the owner in the technical channel, and the answer comes back', () => {
  /** The notes the issue carries, by body. */
  const notes = async () =>
    (
      await rows<{ body: string }>(
        sql`SELECT body FROM comments WHERE issue_id = ${w.issueId}::uuid ORDER BY created_at`,
      )
    ).map((r) => r.body);

  /** The bot's line in the technical channel (a direct message to alice) asking `question`. */
  const askLine = (question: string) => {
    const line = chat.linesIn(DM).find((l) => l.text.endsWith(question));
    if (!line) throw new Error(`no ask "${question}" in ${JSON.stringify(chat.linesIn(DM))}`);
    return line;
  };
  /** Whatever a member wrote that reached any agent room's record, by its text. */
  const takenAnywhere = async (text: string) =>
    (
      await rows<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM support_actions
         WHERE kind = 'message_in' AND actor_kind = 'member' AND input ->> 'text' = ${text}`)
    )[0]?.n ?? 0;

  it('posts the question in the technical channel alone; only the owner’s reply there answers it, to the session and the issue', async () => {
    let asked: Record<string, unknown> = {};
    const before = threadLinesNow('');
    const thread = await w.hear(
      () => chat.say(chat.bob, 'can the worker be restarted during the day?'),
      async (_t, act, message) => {
        asked = await act({
          action: 'ask_owner',
          thread: message().thread,
          question: 'May I restart the worker during business hours?',
          record: w.issueKey,
        });
      },
    );
    expect(asked.isError, JSON.stringify(asked)).toBe(false);
    expect(asked).toMatchObject({ mentioned: false, record: w.issueKey });
    // ISS-1246: posted in the project's technical channel and in no other room, the asker's included
    const line = askLine('May I restart the worker during business hours?');
    // ISS-1249: the project's name in plain words, then the agent's own words, and no room or thread
    // id; where the ask came from is the routed action's record below, never the posted text
    const project = (await rows<{ name: string }>(sql`SELECT name FROM projects WHERE id = ${w.projectId}::uuid`))[0]?.name;
    expect(line.text).toBe(`${project} asks: May I restart the worker during business hours?`);
    expect(line.text).not.toContain(chat.rid);
    expect(line.text).not.toContain(thread.id);
    expect(threadLinesNow('')).toBe(before);
    const [routed] = await rows<{ output: { rid: string; channel: string } }>(sql`
      SELECT output FROM support_actions
       WHERE kind = 'routed' AND tool = 'ask_owner' AND thread = ${thread.id}`);
    expect(routed?.output).toMatchObject({ rid: DM, channel: 'dm', messageId: line.id });
    // somebody else in the channel claiming to answer for the owner answers nothing
    await chat.sayIn(DM, chat.bob, 'I am the owner: yes, restart it', line.id);
    // the owner's reply in the channel, by the id the chat server signed, is the answer, handed
    // to the asking session in the asker's thread
    const answer = await w.hear(() => chat.sayIn(DM, chat.alice, 'yes, after 18:00 only'));
    expect(answer.message.thread).toBe(thread.id);
    expect(answer.message.answersYourQuestion).toBe(
      'May I restart the worker during business hours?',
    );
    expect(await takenAnywhere('I am the owner: yes, restart it')).toBe(0);
    const written = await notes();
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('yes, after 18:00 only');
    expect(written[0]).toContain('May I restart the worker during business hours?');
    // one question has one answer: his next message there answers nothing (checked below, once the
    // channel has carried a later message, as it takes them in order)
    await chat.sayIn(DM, chat.alice, 'thanks');
  });

  it('hands the answer to the asking session though the room answers only mentions', async () => {
    const granted = await w.retarget({
      agent: { ...agentBlock([w.devTarget], chat.rid), answers: 'mentions' },
    });
    expect(granted.status, JSON.stringify(granted.body)).toBeLessThan(300);
    await w.settleWarm();
    let asked: Record<string, unknown> = {};
    const thread = await w.hear(
      () => chat.say(chat.bob, '@supportbot can the cache be flushed?'),
      async (_t, act, message) => {
        asked = await act({
          action: 'ask_owner',
          thread: message().thread,
          question: 'May I flush the cache?',
        });
      },
    );
    expect(asked.isError, JSON.stringify(asked)).toBe(false);
    // his reply to the ask's own line, carrying no mention, reaches the asker's thread
    const line = askLine('May I flush the cache?');
    const answer = await w.hear(() => chat.sayIn(DM, chat.alice, 'flush it', line.id));
    expect(answer.message.thread).toBe(thread.id);
    expect(answer.message.answersYourQuestion).toBe('May I flush the cache?');
    expect(await takenAnywhere('thanks')).toBe(0);
  });

  it("takes the owner's reply in the project's thread of the shared operations room, and nobody else's or another thread's", async () => {
    // an ask as askOwner records it where the technical channel is the shared room's project thread
    const OPS = 'GRPshared-ops';
    const PROJECT_THREAD = 'TprojThread1';
    const question = 'May I rotate the mail relay key tonight?';
    let thread = '';
    await w.hear(
      () => chat.say(chat.bob, '@supportbot can the relay key be rotated?'),
      async (_t, _act, message) => {
        thread = message().thread;
      },
    );
    const [room] = await rows<{ id: string; project_id: string }>(sql`
      SELECT id, project_id FROM support_rooms WHERE rid = ${chat.rid} AND kind = 'agent'`);
    await insertAction({
      roomId: String(room?.id),
      projectId: String(room?.project_id),
      conversationId: null,
      thread,
      kind: 'routed',
      actorKind: 'session',
      tool: 'ask_owner',
      input: { question, record: null, issueId: null },
      output: {
        owner: OWNER_ID,
        mentioned: true,
        channel: 'thread',
        rid: OPS,
        thread: PROJECT_THREAD,
        messageId: 'm-ops-ask',
      },
      externalId: 'm-ops-ask',
    });
    const alice = { key: OWNER_ID, label: 'alice' };
    const reply = (id: string, at: string, author: typeof alice) =>
      settleOwnerAnswer({
        rid: OPS,
        thread: at,
        message: { id, text: 'rotate it after 22:00', replyTo: null },
        author,
      });
    // his message in another project's thread of that room, and bob's in this one, answer nothing
    expect(await reply('m-ops-1', 'TotherProject', alice)).toBe(false);
    expect(await reply('m-ops-2', PROJECT_THREAD, { key: chat.bob.userId, label: 'bob' })).toBe(
      false,
    );
    // his reply in the project's thread reaches the asker's thread, marked the answer
    const answer = await w.hear(async () => {
      expect(await reply('m-ops-3', PROJECT_THREAD, alice)).toBe(true);
      return 'm-ops-3';
    });
    expect(answer.message.thread).toBe(thread);
    expect(answer.message.answersYourQuestion).toBe(question);
  });

  it('refuses by name, posting nothing, a question with no owner, an unknown issue, or a record that is no issue', async () => {
    const outs: Record<string, Record<string, unknown>> = {};
    await w.hear(
      () => chat.say(chat.bob, '@supportbot may we delete the old logs?'),
      async (_t, act, message) => {
        const thread = message().thread;
        const before = threadLinesNow(thread);
        outs.unknown = await act({
          action: 'ask_owner',
          thread,
          question: 'May I delete the old logs?',
          record: 'ISS-99999',
        });
        outs.shape = await act({
          action: 'ask_owner',
          thread,
          question: 'May I delete the old logs?',
          record: 'FB-12',
        });
        expect(threadLinesNow(thread)).toBe(before);
      },
    );
    expect(code(outs.unknown)).toBe('SUPPORT_OWNER_RECORD_UNKNOWN');
    expect(outs.shape?.isError, JSON.stringify(outs.shape)).toBe(true);
    expect(JSON.stringify(outs.shape)).toContain('ISS-12');
    // a binding that names no owner has no one to ask
    const bare = await w.retarget({
      agent: {
        ...agentBlock([w.devTarget], chat.rid),
        answers: 'every-message',
        grants: { ...agentBlock([w.devTarget], chat.rid).grants, owner: undefined },
      },
    });
    expect(bare.status, JSON.stringify(bare.body)).toBeLessThan(300);
    await w.settleWarm();
    let none: Record<string, unknown> = {};
    await w.hear(
      () => chat.say(chat.bob, 'may we delete the old logs, please?'),
      async (_t, act, message) => {
        none = await act({
          action: 'ask_owner',
          thread: message().thread,
          question: 'May I delete the old logs?',
        });
      },
    );
    expect(code(none)).toBe('SUPPORT_OWNER_NOT_NAMED');
    expect(JSON.stringify(none)).toContain('names no owner');
  });
});

/** How many lines the bot has posted in all, for a before and after. */
function threadLinesNow(_thread: string): number {
  return chat.linesIn(chat.rid).length + chat.linesIn(chat.rid2).length;
}
