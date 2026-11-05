// @direct-test-of packages/core/src/support/inbound.ts
// @direct-test-of packages/core/src/support/store.ts

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { rows } from '../helpers/factories.js';
import { SupportWorld, type Turn } from '../helpers/support-world.js';

// ISS-985: a room answering only mentions hands the session a reply mentioning nobody in a thread
// the session has already replied in, as a mention would be, and keeps every other message without
// a mention as the thread's context. The 04:47 shape of Suport-HRM: a mention, the bot's answer in
// its thread, then a follow-up in that thread with no @. The world is support-room-e2e's: the real
// Rocket.Chat connection manager against a chat server and a box playing the session's Claude Code.

const w = new SupportWorld();
let roomId = '';

beforeAll(async () => {
  await w.start();
  await w.bind({ product: 'HRM, the people back office', answers: 'mentions' });
  roomId = String((await w.rooms())[0]?.id);
}, 120_000);

afterAll(() => w.stop());

/** Every member message the session was handed, in the order it was handed. */
const seen: Turn[] = [];
const handedTexts = () => seen.flatMap((t) => t.messages.filter((m) => m.from !== 'forge'));

/**
 * The session: a turn holding a message `failing` still owes a failure ends failed, as a crash
 * does; any other turn answers each member message except those in `silent`, in its own thread.
 */
const failing = new Map<string, number>();
const silent = new Set<string>();
function play() {
  w.box.finishTurns = true;
  w.box.model = async (turn, act) => {
    seen.push(turn);
    const owed = turn.messages.find((m) => (failing.get(m.text) ?? 0) > 0);
    if (owed) {
      failing.set(owed.text, (failing.get(owed.text) ?? 0) - 1);
      w.box.turnEnd = 'failed';
      return;
    }
    w.box.turnEnd = 'completed';
    for (const m of turn.messages) {
      if (m.from === 'forge' || silent.has(m.text)) continue;
      await act({ action: 'reply', thread: m.thread, text: answerTo(m.text) });
    }
  };
}

/** The session's answer to `text`, naming nobody: a reply names at most the asker. */
const answerTo = (text: string) => `Answered: ${text.replace(/@\S+\s*/g, '')}`;

/** Wait until the bot posted its answer to `text` in `thread`. */
const answered = (thread: string, text: string) =>
  w.untilLines((ls) => ls.some((l) => l.tmid === thread && l.text === answerTo(text)));

/** How core recorded one member message: whether it was kept, and whether a turn was handed it. */
async function recordOf(messageId: string): Promise<{ kept: boolean; handed: boolean }> {
  const [row] = await rows<{ handed: boolean }>(sql`
    SELECT COALESCE(output, '{}'::jsonb) ? 'path' AS handed FROM support_actions
     WHERE room_id = ${roomId}::uuid AND kind = 'message_in' AND external_id = ${messageId}`);
  return { kept: Boolean(row), handed: Boolean(row?.handed) };
}

/**
 * A mention in a thread of its own, answered: once its answer is posted every message core recorded
 * before it has been decided, so a message still unhanded then was kept as context only.
 */
async function drained(): Promise<void> {
  const text = `@supportbot marker ${Math.random().toString(36).slice(2, 8)}`;
  const thread = await w.chat.say(w.chat.alice, text);
  await answered(thread, text);
}

describe('ISS-985: a room answering only mentions', () => {
  it('hands the session a reply mentioning nobody in a thread it has replied in, and it is answered (the 04:47 shape)', async () => {
    await w.untilWarm();
    play();
    const ask = '@supportbot report on the two leave requests in this thread';
    const opener = await w.chat.say(w.chat.bob, ask);
    await answered(opener, ask);
    const followUp = 'have both passed testing yet?';
    const reply = await w.chat.say(w.chat.bob, followUp, opener);
    await answered(opener, followUp);
    expect(await recordOf(reply)).toEqual({ kept: true, handed: true });
    // the session reads it as a message mentioning nobody, never as one naming it
    expect(handedTexts().find((m) => m.text === followUp)?.thread).toBe(opener);
  }, 60_000);

  it('keeps a top-level message without a mention as context only', async () => {
    play();
    const quiet = 'lunch at noon?';
    const top = await w.chat.say(w.chat.bob, quiet);
    await expect.poll(async () => (await recordOf(top)).kept, { timeout: 15_000 }).toBe(true);
    await drained();
    expect(await recordOf(top)).toEqual({ kept: true, handed: false });
    expect(handedTexts().map((m) => m.text)).not.toContain(quiet);
  }, 60_000);

  it('keeps a reply without a mention as context only in a thread the bot never posted in', async () => {
    play();
    // a thread opened without the bot
    const chat = await w.chat.say(w.chat.alice, 'anyone around this afternoon?');
    const among = await w.chat.say(w.chat.bob, 'I am, after three', chat);
    // a thread that mentioned the bot, which never replied there: the fact is its reply, not a mention
    const unanswered = '@supportbot are you there?';
    silent.add(unanswered);
    const asked = await w.chat.say(w.chat.bob, unanswered);
    await expect
      .poll(() => handedTexts().map((m) => m.text), { timeout: 15_000 })
      .toContain(unanswered);
    const after = await w.chat.say(w.chat.bob, 'never mind, found it', asked);
    // a reply naming someone else in a thread the bot answered is for them, not the bot
    const ask = '@supportbot where is the leave form?';
    const answeredThread = await w.chat.say(w.chat.bob, ask);
    await answered(answeredThread, ask);
    const toAlice = await w.chat.say(w.chat.bob, '@alice can you send it to me?', answeredThread);
    for (const id of [among, after, toAlice]) {
      await expect.poll(async () => (await recordOf(id)).kept, { timeout: 15_000 }).toBe(true);
    }
    await drained();
    for (const id of [among, after, toAlice]) {
      expect(await recordOf(id), id).toEqual({ kept: true, handed: false });
    }
    expect(handedTexts().map((m) => m.text)).not.toContain('never mind, found it');
  }, 60_000);

  it('counts a thread reply handed this way as unanswered when its turn fails, and tries it again', async () => {
    play();
    const ask = '@supportbot when is payroll closed?';
    const opener = await w.chat.say(w.chat.bob, ask);
    await answered(opener, ask);
    const followUp = 'and for contractors?';
    failing.set(followUp, 1);
    await w.chat.say(w.chat.bob, followUp, opener);
    await answered(opener, followUp);
    expect(handedTexts().filter((m) => m.text === followUp)).toHaveLength(2);
    const tries = (await w.actions(roomId)).filter(
      (a) => a.kind === 'refused' && a.tool === 'turn_retry' && a.thread === opener,
    ) as { output: Record<string, unknown> }[];
    expect(tries).toHaveLength(1);
    expect(tries[0]?.output).toMatchObject({ try: 1, of: 3 });
    expect(String(tries[0]?.output.cause)).toMatch(/ended failed/);
  }, 60_000);
});
