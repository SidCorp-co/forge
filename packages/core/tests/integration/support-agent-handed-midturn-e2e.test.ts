import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { deliverWaiting } from '../../src/support/dispatch.js';
import { insertAction, threadConversation } from '../../src/support/store.js';
import { rows } from '../helpers/factories.js';
import { AgentWorld } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/thread-requests.ts
// @direct-test-of packages/core/src/support/service.ts
//
// ISS-1221 (FB-623): a request handed into the running turn while the session wrote the result of
// the one before, and before that result was recorded, gets a result of its own. The owner's new
// question in thread BeK4GQzYXZpMkgtac arrived while the answer to his previous one was being posted,
// and its answer was refused SUPPORT_ONE_RESULT_PER_REQUEST, so it waited on his next message. An
// acknowledgement after both results is still refused by name.

const w = new AgentWorld();
let chat: StandInRocketChat;
let roomId = '';

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  const [room] = await rows<{ id: string }>(sql`
    SELECT id FROM support_rooms WHERE project_id = ${w.projectId}::uuid AND rid = ${chat.rid}`);
  roomId = String(room?.id);
}, 120_000);

afterAll(() => w.stop());

/** A note core tells the session in `thread`, handed on at once. */
async function note(thread: string, said: string): Promise<void> {
  await insertAction({
    roomId,
    projectId: w.projectId,
    conversationId: await threadConversation(roomId, thread),
    thread,
    kind: 'message_in',
    actorKind: 'core',
    input: { note: `${said} Post its result in this thread.` },
    externalId: `note:${said}`,
  });
  await deliverWaiting(roomId);
}

describe('ISS-1221: a request handed into the running turn before the last result was recorded', () => {
  it('posts its own result after that one, and still refuses an acknowledgement', async () => {
    const asked = await w.hear(
      () => chat.say(chat.bob, 'are the two exports ready?'),
      async (_t, act, m) => {
        await act({ action: 'reply', thread: m().thread, text: 'Recorded for the team.' });
      },
    );
    const thread = asked.id;
    await w.settleWarm();
    const outs: Record<string, unknown>[] = [];
    let injected = false;
    let answerInjected = () => {};
    const resultWritten = new Promise<void>((r) => {
      answerInjected = r;
    });
    w.box.model = async (turn, act) => {
      if (!turn.messages.some((m) => m.from === 'forge' && m.thread === thread)) return;
      if (turn.event === 'session.send') {
        // the second request, read while the first result is still being written
        injected = true;
        await resultWritten;
        outs.push(await act({ action: 'reply', thread, text: 'The invoice export is ready.' }));
        outs.push(await act({ action: 'reply', thread, text: 'Still checking the rest.' }));
        return;
      }
      // the second request is handed into this running turn before the first result is posted
      await note(thread, 'The invoice export is live now.');
      await expect.poll(() => injected, { timeout: 15_000 }).toBe(true);
      outs.push(await act({ action: 'reply', thread, text: 'The order export is ready.' }));
      answerInjected();
    };
    await note(thread, 'The order export is live now.');
    await expect.poll(() => outs.length, { timeout: 30_000 }).toBe(3);
    await w.settleWarm();
    expect(outs[0]?.isError, JSON.stringify(outs[0])).toBe(false);
    // the planted red: before ISS-1221 this was SUPPORT_ONE_RESULT_PER_REQUEST
    expect(outs[1]?.isError, JSON.stringify(outs[1])).toBe(false);
    expect(code(outs[2])).toBe('SUPPORT_ONE_RESULT_PER_REQUEST');
    expect(w.threadLines(chat.rid, thread).map((l) => l.text)).toEqual([
      'Recorded for the team.',
      'The order export is ready.',
      'The invoice export is ready.',
    ]);
  });
});
