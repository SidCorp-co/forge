import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { coreTimers } from '../../src/timer-registry.js';
import { rows } from '../helpers/factories.js';
import { SupportWorld, type Turn } from '../helpers/support-world.js';

// ISS-850: a member's message handed to a turn that core's restart cut off is read delivered, and
// no turn end is ever reported for it, so neither the drain nor the failed-turn notice reaches it.
// When core starts and when a box reconnects, such a message is handed to the session once more,
// and where that is spent the thread is told it went unanswered. The world is support-room-e2e's.

const w = new SupportWorld();
let roomId = '';
let sessionId = '';
const seen: Turn[] = [];
/** Whether the session answers what it is handed. */
let answers = false;

beforeAll(async () => {
  await w.start();
  await w.bind();
  const [room] = await w.rooms();
  roomId = String(room?.id);
  sessionId = String(room?.sessionId);
  w.box.model = async (turn, act) => {
    seen.push(turn);
    if (!answers) return;
    for (const m of turn.messages) {
      if (m.from === 'forge') continue;
      await act({ action: 'reply', thread: m.thread, text: `Answered: ${m.text}` });
    }
  };
}, 120_000);

afterAll(() => w.stop());

/** How many turns the session was handed `text` in. */
const handed = (text: string) => seen.filter((t) => t.messages.some((m) => m.text === text)).length;

/**
 * A turn is running `text` when core goes down: the box loses it without a word, and the turn's
 * beat goes as old as a dead one's.
 */
async function lostMidTurn(text: string, reply = false): Promise<string> {
  w.box.finishTurns = false;
  answers = reply;
  const before = handed(text);
  const id = await w.chat.say(w.chat.alice, text);
  await expect.poll(() => handed(text), { timeout: 15_000 }).toBe(before + 1);
  if (reply) await w.untilLines((ls) => ls.some((l) => l.tmid === id));
  await loseTheTurn();
  return id;
}

async function loseTheTurn(): Promise<void> {
  w.box.lose(sessionId);
  await db.execute(sql`UPDATE agent_sessions
    SET last_heartbeat_at = now() - interval '10 minutes', updated_at = now() - interval '10 minutes'
    WHERE id = ${sessionId}::uuid`);
  const [s] = await rows<{ status: string }>(
    sql`SELECT status FROM agent_sessions WHERE id = ${sessionId}::uuid`,
  );
  expect(s?.status).toBe('running');
}

/** What core runs for the support rooms as it starts: every such timer that runs at start. */
async function coreStarts(): Promise<void> {
  for (const t of coreTimers()) {
    if (t.kind === 'process' && t.name.startsWith('support.') && t.runAtStart) await t.run();
  }
}

/** The box's socket drops with core and comes back. */
async function boxReconnects(): Promise<void> {
  w.box.close();
  await w.box.connect();
}

const failedLine = (l: { text: string }) => l.text.startsWith('I could not finish answering');

async function toldFailed(thread: string): Promise<number> {
  return (await w.chat.botLines()).filter((l) => l.tmid === thread && failedLine(l)).length;
}

describe('ISS-850: a turn core lost to its restart', () => {
  it('hands the message to the session once more when core starts, and only once', async () => {
    await w.untilWarm();
    const text = 'Is the CSV export broken?';
    const thread = await lostMidTurn(text);
    // core comes back: the session answers what it is handed now
    answers = true;
    w.box.finishTurns = true;
    await coreStarts();
    await boxReconnects();
    await expect.poll(() => handed(text), { timeout: 15_000 }).toBe(2);
    await w.untilLines((ls) => ls.some((l) => l.tmid === thread && l.text === `Answered: ${text}`));
    const [row] = await rows<{ redelivered: string | null }>(sql`
      SELECT output->>'redelivered' AS redelivered FROM support_actions
       WHERE room_id = ${roomId}::uuid AND kind = 'message_in' AND input->>'text' = ${text}`);
    expect(row?.redelivered).toBeTruthy();
    // core starting again, and the box coming back again, hand it on no more
    await coreStarts();
    await boxReconnects();
    await new Promise((r) => setTimeout(r, 500));
    expect(handed(text)).toBe(2);
    expect(await toldFailed(thread)).toBe(0);
  }, 90_000);

  it('a message lost a second time is not handed on again: its thread is told it went unanswered', async () => {
    const text = 'Where did my invoice go?';
    const thread = await lostMidTurn(text);
    await coreStarts();
    // re-delivered once, into a turn the next restart loses as well
    await expect.poll(() => handed(text), { timeout: 15_000 }).toBe(2);
    await loseTheTurn();
    await boxReconnects();
    await expect.poll(() => toldFailed(thread), { timeout: 15_000 }).toBe(1);
    await coreStarts();
    await new Promise((r) => setTimeout(r, 500));
    expect(handed(text)).toBe(2);
    expect(await toldFailed(thread)).toBe(1);
    const told = (await w.actions(roomId)).filter(
      (a) => a.kind === 'refused' && a.tool === 'turn_failed' && a.thread === thread,
    );
    expect(told).toHaveLength(1);
  }, 90_000);

  it('a message whose thread got the session’s reply before the turn was lost is not handed on', async () => {
    const text = 'Thanks, what about stock?';
    const thread = await lostMidTurn(text, true);
    answers = true;
    w.box.finishTurns = true;
    await coreStarts();
    await boxReconnects();
    await new Promise((r) => setTimeout(r, 1_000));
    expect(handed(text)).toBe(1);
    expect(await toldFailed(thread)).toBe(0);
    const lines = (await w.chat.botLines()).filter((l) => l.tmid === thread);
    expect(lines.map((l) => l.text)).toEqual([`Answered: ${text}`]);
  }, 90_000);
});
