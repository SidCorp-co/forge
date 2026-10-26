import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { rows } from '../helpers/factories.js';
import { SupportWorld, type Turn } from '../helpers/support-world.js';

// REQ-75 r2, BC-11 and BC-18: a support session's turn that ends failed tells each thread it left
// with no answer so, once, records it, and never hands those messages to a turn again. The world is
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

describe('REQ-75: a turn that fails', () => {
  it('tells a thread a failed turn left unanswered, once, and never hands it that turn again', async () => {
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
    await expect
      .poll(async () => {
        const [r] = await rows<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM support_actions WHERE room_id = ${roomId}::uuid AND kind = 'message_in' AND delivered_at IS NULL`,
        );
        return r?.n;
      })
      .toBe(2);
    w.box.finishTurns = true;
    w.box.turnEnd = 'failed';
    await w.box.finish(sessionId, 'unused');
    await expect.poll(() => seen.length, { timeout: 15_000 }).toBe(2);
    await w.untilLines((ls) => ls.some((l) => l.tmid === parcel && l.text === 'On its way.'));
    await expect
      .poll(async () => (await w.rooms())[0]?.sessionStatus, { timeout: 15_000 })
      .toBe('failed');
    const failedLine = (l: { text: string }) => l.text.startsWith('I could not finish answering');
    await w.untilLines((ls) => ls.some((l) => l.tmid === refund && failedLine(l)));
    const lines = await w.chat.botLines();
    // the first failed turn held only "Hold on"; the second left refund unanswered, not parcel
    expect(lines.filter((l) => l.tmid === hold && failedLine(l))).toHaveLength(1);
    expect(lines.filter((l) => l.tmid === refund && failedLine(l))).toHaveLength(1);
    expect(lines.some((l) => l.tmid === parcel && failedLine(l))).toBe(false);
    const told = (await w.actions(roomId)).filter(
      (a) => a.kind === 'refused' && (a as { tool?: string }).tool === 'turn_failed',
    );
    expect(told).toHaveLength(2);
    // nothing failed is handed to a turn again: the next message goes alone
    w.box.turnEnd = 'completed';
    const next = await w.chat.say(w.chat.bob, 'Any news?', refund);
    await expect.poll(() => seen.length, { timeout: 15_000 }).toBe(3);
    expect(seen[2]?.messages.map((m) => m.text)).toEqual(['Any news?']);
    expect(next).toBeTruthy();
  });
});
