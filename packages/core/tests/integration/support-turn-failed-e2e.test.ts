// @direct-test-of packages/core/src/support/last-resort.ts

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { LAST_RESORT_LINES } from '../../src/conversations/last-resort.js';
import { rows } from '../helpers/factories.js';
import { SupportWorld, type Turn } from '../helpers/support-world.js';

// REQ-75 r2, BC-11 and BC-18: a support session's turn that ends failed tells each thread it left
// with no answer so, once, in core's plain Vietnamese last-resort line (ISS-875), records it, and never hands those messages to a turn again; that holds
// for the messages written into the turn while it ran as for the one that started it. The world is
// support-room-e2e's: the real Rocket.Chat connection manager against a chat server and a box
// playing the session's Claude Code.

const w = new SupportWorld();
let roomId = '';
let sessionId = '';

beforeAll(async () => {
  await w.start();
  await w.bind();
  const [room] = await w.rooms();
  roomId = String(room?.id);
  sessionId = String(room?.sessionId);
}, 120_000);

afterAll(() => w.stop());

describe('ISS-875: a member past the hourly limit', () => {
  it('is told once in each thread they write in, in the plain Vietnamese line, and the session is handed nothing more', async () => {
    await w.untilWarm();
    const limited = {
      product: 'Catalog, the shop back office',
      grants: { abilities: ['read_checkout', 'file_items'] },
    };
    const held = await w.regrant({ ...limited, limits: { messagesPerUserPerHour: 1 } });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    await w.settleWarm();
    const seen: string[] = [];
    w.box.model = async (turn) => {
      for (const m of turn.messages) seen.push(m.text);
    };
    const limitLine = (l: { text: string }) => l.text === LAST_RESORT_LINES.rate_limited;
    // her first message this hour is handed on; the next ones are past a limit of one
    const first = await w.chat.say(w.chat.alice, 'Is the shop open?');
    await expect.poll(() => seen, { timeout: 15_000 }).toContain('Is the shop open?');
    await w.chat.say(w.chat.alice, 'One more thing', first);
    await w.untilLines((ls) => ls.some((l) => l.tmid === first && limitLine(l)));
    await w.chat.say(w.chat.alice, 'And another', first);
    const other = await w.chat.say(w.chat.alice, 'A new question');
    await w.untilLines((ls) => ls.some((l) => l.tmid === other && limitLine(l)));
    await new Promise((r) => setTimeout(r, 500));
    const lines = await w.chat.botLines();
    expect(lines.filter((l) => l.tmid === first && limitLine(l))).toHaveLength(1);
    expect(lines.filter((l) => l.tmid === other && limitLine(l))).toHaveLength(1);
    expect(seen).toEqual(['Is the shop open?']);
    // the room's own limits again, for what follows
    expect((await w.regrant(limited)).status).toBe(200);
    await w.settleWarm();
  });
});

describe('REQ-75: a turn that fails', () => {
  it('tells a thread a failed turn left unanswered, written into it or not, once, and never hands it that turn again', async () => {
    await w.untilWarm();
    const seen: Turn[] = [];
    w.box.model = async (turn, act) => {
      seen.push(turn);
      // the turn answers one thread, then its process dies before the other
      const answered = turn.messages.find((m) => m.text === 'Where is my parcel?');
      if (answered) await act({ action: 'reply', thread: answered.thread, text: 'On its way.' });
    };
    w.box.finishTurns = false;
    const hold = await w.chat.say(w.chat.alice, 'Hold on');
    await expect.poll(() => seen.length, { timeout: 15_000 }).toBe(1);
    const parcel = await w.chat.say(w.chat.alice, 'Where is my parcel?');
    const refund = await w.chat.say(w.chat.bob, 'Refund please');
    // both are written into the running turn, and the turn answers one of them
    await expect.poll(() => seen.flatMap((t) => t.messages).length, { timeout: 15_000 }).toBe(3);
    expect(seen.slice(1).every((t) => t.event === 'session.send')).toBe(true);
    await w.untilLines((ls) => ls.some((l) => l.tmid === parcel && l.text === 'On its way.'));
    const [waiting] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM support_actions WHERE room_id = ${roomId}::uuid AND kind = 'message_in' AND delivered_at IS NULL`,
    );
    expect(waiting?.n).toBe(0);
    w.box.finishTurns = true;
    w.box.turnEnd = 'failed';
    await w.box.finish(sessionId, 'unused');
    await expect
      .poll(async () => (await w.rooms())[0]?.sessionStatus, { timeout: 15_000 })
      .toBe('failed');
    const failedLine = (l: { text: string }) => l.text === LAST_RESORT_LINES.turn_failed;
    await w.untilLines((ls) => ls.some((l) => l.tmid === refund && failedLine(l)));
    await w.untilLines((ls) => ls.some((l) => l.tmid === hold && failedLine(l)));
    const lines = await w.chat.botLines();
    // the failed turn left hold and refund unanswered, not parcel, which it answered
    expect(lines.filter((l) => l.tmid === hold && failedLine(l))).toHaveLength(1);
    expect(lines.filter((l) => l.tmid === refund && failedLine(l))).toHaveLength(1);
    expect(lines.some((l) => l.tmid === parcel && failedLine(l))).toBe(false);
    // each thread's record is written after its line is posted, so a line can be read before it
    const told = async () =>
      (await w.actions(roomId)).filter(
        (a) => a.kind === 'refused' && (a as { tool?: string }).tool === 'turn_failed',
      ).length;
    await expect.poll(told, { timeout: 15_000 }).toBe(2);
    // nothing failed is handed to a turn again: the next message goes alone, and its turn failing
    // as well is recorded, but the thread was told its one line already (ISS-875)
    const before = seen.length;
    const next = await w.chat.say(w.chat.bob, 'Any news?', refund);
    await expect.poll(() => seen.length, { timeout: 15_000 }).toBe(before + 1);
    expect(seen[before]?.messages.map((m) => m.text)).toEqual(['Any news?']);
    expect(next).toBeTruthy();
    await expect.poll(told, { timeout: 15_000 }).toBe(3);
    const after = await w.chat.botLines();
    expect(after.filter((l) => l.tmid === refund && failedLine(l))).toHaveLength(1);
    w.box.turnEnd = 'completed';
  });
});
