// @direct-test-of packages/core/src/support/turn-retry.ts
// @direct-test-of packages/core/src/support/last-resort.ts
// @direct-test-of packages/core/src/support/delivery.ts
// @direct-test-of packages/core/src/support/dispatch.ts
// @direct-test-of packages/core/src/conversations/last-resort.ts

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { ROOM_STILL_QUEUED_LINES } from '../../src/conversations/last-resort.js';
import { HELD_MESSAGE_MAX_AGE_MS } from '../../src/support/turn-retry.js';
import { rows } from '../helpers/factories.js';
import { SupportWorld, type Turn } from '../helpers/support-world.js';

// ISS-1105 (forge-core-61, epod sid-catalog, 2026-11-06): 19 threads of plain room chatter, held
// about 12 hours behind a session that never answered, were each told core's failed-turn line
// within 45 s at 04:13 local. A held message has an age bound: past it, it is dropped with a record
// on the room and its thread is never told. A session failure tells only what still waits on an
// answer within the bound, in one line to the room, never one post per thread.

const w = new SupportWorld();
let roomId = '';
const seen: Turn[] = [];

beforeAll(async () => {
  await w.start();
  await w.bind();
  roomId = String((await w.rooms())[0]?.id);
}, 120_000);

/** Every turn the session is handed fails from now, as one behind a broken session does. */
let broken = false;
async function breakTheSession(): Promise<void> {
  if (broken) return;
  broken = true;
  await w.untilWarm();
  w.box.finishTurns = true;
  w.box.turnEnd = 'failed';
  w.box.model = async (turn) => {
    seen.push(turn);
  };
}

afterAll(() => w.stop());

const handed = (text: string) => seen.filter((t) => t.messages.some((m) => m.text === text)).length;
const recorded = async (tool: string) =>
  (await w.actions(roomId)).filter((a) => a.kind === 'refused' && a.tool === tool) as {
    thread: string;
    output: Record<string, unknown>;
  }[];

describe('ISS-1105: a held message has an age bound, and a broken session is told once per room', () => {
  it('drops 19 chatter messages held 12 hours with a record on the room, and tells none of their threads', async () => {
    await w.untilWarm();
    // the session's turn hangs while the room talks: the 19 messages wait behind it unanswered
    w.box.finishTurns = false;
    w.box.model = async (turn) => {
      seen.push(turn);
    };
    const texts = Array.from({ length: 19 }, (_, i) => `chatter ${i + 1} about lunch`);
    const threads: string[] = [];
    for (const [i, text] of texts.entries()) {
      threads.push(await w.chat.say(i % 2 ? w.chat.bob : w.chat.alice, text));
    }
    await expect
      .poll(
        async () =>
          (
            await rows<{ n: number }>(sql`
              SELECT count(*)::int AS n FROM support_actions
               WHERE room_id = ${roomId}::uuid AND kind = 'message_in' AND input->>'text' LIKE 'chatter %'`)
          )[0]?.n,
        { timeout: 20_000 },
      )
      .toBe(19);
    // held 12 hours: the session never answered them
    await rows(sql`
      UPDATE support_actions SET created_at = created_at - interval '12 hours'
       WHERE room_id = ${roomId}::uuid AND kind = 'message_in' AND input->>'text' LIKE 'chatter %'`);
    // then the session fails, and every turn after it fails too
    const hung = String((await w.rooms())[0]?.sessionId);
    broken = true;
    w.box.turnEnd = 'failed';
    w.box.finishTurns = true;
    await w.box.finish(hung, 'claude-hung');
    // the failed tries run out well inside a minute: none of the 19 threads is told, ever
    await expect
      .poll(async () => (await recorded('held_too_long')).length, { timeout: 60_000 })
      .toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 30_000));
    const lines = await w.chat.botLines();
    expect(lines.filter((l) => l.tmid && threads.includes(l.tmid))).toEqual([]);
    expect(lines.filter((l) => !l.tmid)).toEqual([]);
    // each dropped once, its who, when and why on the room's record
    const dropped = (await recorded('held_too_long')).flatMap(
      (a) => a.output.messages as { thread: string; who: string; at: string }[],
    );
    expect(dropped.map((d) => d.thread).sort()).toEqual([...threads].sort());
    expect(dropped.every((d) => ['alice', 'bob'].includes(d.who) && d.at)).toBe(true);
    expect((await recorded('held_too_long'))[0]?.output).toMatchObject({
      maxAgeMs: HELD_MESSAGE_MAX_AGE_MS,
    });
    const [left] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM support_actions
       WHERE room_id = ${roomId}::uuid AND kind = 'message_in' AND delivered_at IS NULL
         AND input->>'text' LIKE 'chatter %'`);
    expect(left?.n).toBe(0);
    // no turn takes a dropped message again
    const before = texts.map(handed);
    await new Promise((r) => setTimeout(r, 6_000));
    expect(texts.map(handed)).toEqual(before);
  }, 150_000);

  it('tells a fresh failure once, in one line at the room’s top level, never in each thread', async () => {
    await breakTheSession();
    const asks = [
      await w.chat.say(w.chat.alice, '@supportbot is the shop down?'),
      await w.chat.say(w.chat.bob, 'my order page is blank'),
      await w.chat.say(w.chat.bob, '@alice did you get my mail'),
    ];
    await expect
      .poll(async () => (await w.chat.botLines()).filter((l) => !l.tmid).length, {
        timeout: 60_000,
      })
      .toBe(1);
    await new Promise((r) => setTimeout(r, 5_000));
    const lines = await w.chat.botLines();
    expect(lines.filter((l) => !l.tmid).map((l) => l.text)).toEqual([ROOM_STILL_QUEUED_LINES.en]);
    expect(lines.filter((l) => l.tmid && asks.includes(l.tmid))).toEqual([]);
    // every thread's failure is on the record as its tries run out; the room was told once for all
    await expect
      .poll(async () => new Set((await recorded('turn_failed')).map((a) => a.thread)).size, {
        timeout: 60_000,
      })
      .toBe(asks.length);
    const told = await recorded('turn_failed');
    expect((await w.chat.botLines()).filter((l) => !l.tmid)).toHaveLength(1);
    // the message to someone else was never what the room was told for
    const forOthers = told.find((a) => a.thread === asks[2]);
    expect(forOthers?.output).toMatchObject({ waitsOnAnswer: false });
  }, 120_000);
});
