// @direct-test-of packages/core/src/support/lost-turns.ts
// @direct-test-of packages/core/src/support/turn-retry.ts
// @direct-test-of packages/core/src/support/room-session.ts

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { ROOM_STILL_QUEUED_LINES, STILL_QUEUED_LINE } from '../../src/conversations/last-resort.js';
import { db } from '../../src/db/client.js';
import { warmSupportRoom } from '../../src/support/warm.js';
import { coreTimers } from '../../src/timer-registry.js';
import { rows } from '../helpers/factories.js';
import { SupportWorld, type Turn } from '../helpers/support-world.js';

// ISS-850: a member's message handed to a turn that core's restart cut off is read delivered, and
// no turn end is ever reported for it, so neither the drain nor the failed-turn notice reaches it.
// When core starts and when a box reconnects, such a message is tried again as any failed turn's is
// (ISS-977): handed to the session after a short back-off, and only once its tries ran out is the
// thread told, the message still queued. The world is support-room-e2e's.

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
  // the room's session now: one a lost turn ended is let go and the room takes a fresh one (ISS-1101)
  const [room] = await w.rooms();
  sessionId = String(room?.sessionId);
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

const failedLine = (l: { text: string }) =>
  l.text === STILL_QUEUED_LINE || Object.values(ROOM_STILL_QUEUED_LINES).includes(l.text);

/** Core's failed-turn lines inside `thread`: none since ISS-1105, which tells the room once instead. */
async function toldInThread(thread: string): Promise<number> {
  return (await w.chat.botLines()).filter((l) => l.tmid === thread && failedLine(l)).length;
}

/**
 * Core's failed-turn lines told the room (ISS-1105): inside the thread a top-level line of the bot
 * opened, its report thread (ISS-1224), and never at the top level itself.
 */
async function toldTheRoom(): Promise<number> {
  const lines = await w.chat.botLines();
  if (lines.some((l) => !l.tmid && failedLine(l))) return -1;
  const anchors = lines.filter((l) => !l.tmid).map((l) => l.id);
  return lines.filter((l) => l.tmid && anchors.includes(l.tmid) && failedLine(l)).length;
}

describe('ISS-850: a turn core lost to its restart', () => {
  it('hands the message to the session again when core starts, and not once it was answered', async () => {
    await w.untilWarm();
    const text = 'Is the CSV export broken?';
    const thread = await lostMidTurn(text);
    // core comes back: the session answers what it is handed now
    answers = true;
    w.box.finishTurns = true;
    await coreStarts();
    // The ended turn's own bridge hands the room on after its commit, unawaited, and may claim the
    // message first; its socket dropped mid hand-on refuses NO_CLAUDE_CLIENT and backs the room off.
    await expect.poll(() => handed(text), { timeout: 15_000 }).toBe(2);
    await w.untilLines((ls) => ls.some((l) => l.tmid === thread && l.text === `Answered: ${text}`));
    const [row] = await rows<{ tries: number | null }>(sql`
      SELECT (output->>'tries')::int AS tries FROM support_actions
       WHERE room_id = ${roomId}::uuid AND kind = 'message_in' AND input->>'text' = ${text}`);
    expect(row?.tries).toBe(1);
    // the box coming back, core starting again, and the box coming back again hand it on no more
    await boxReconnects();
    await coreStarts();
    await boxReconnects();
    await new Promise((r) => setTimeout(r, 500));
    expect(handed(text)).toBe(2);
    expect(await toldInThread(thread)).toBe(0);
  }, 90_000);

  // A lost turn ends its session, and the room's next turn opens a fresh one (ISS-1101). A fresh
  // session's warm-up that completes ends the back-off of what waits (ISS-977,
  // `delivery.ts:endBackOff`, from `dispatch.ts:onSupportTurnEnded`): a completed turn shows the
  // fault cleared, so a message whose tries ran out still goes with the room's next turn. Whether
  // that warm-up comes at once is a race: the box coming back fires both the lost-turn recovery
  // (`index.ts:registerSupportRooms`, onBoxListening) and its rooms' warm-up
  // (`warm.ts:warmRoomsOfDevice`), and only a warm-up that runs after the recovery ended the lost
  // session warms the fresh one; the sweep then skips the room for `WARM_RETRY_MS` after its last
  // warm-up. So the witness warms the room as the box coming online does, and waits for the hand-over.
  it('a message lost on every try is told once its tries ran out, stays queued, and goes once a fresh session completes a turn', async () => {
    const text = 'Where did my invoice go?';
    const thread = await lostMidTurn(text);
    await coreStarts();
    await expect.poll(() => handed(text), { timeout: 30_000 }).toBe(2);
    await loseTheTurn();
    await boxReconnects();
    await expect.poll(() => handed(text), { timeout: 30_000 }).toBe(3);
    expect(await toldTheRoom()).toBe(0);
    await loseTheTurn();
    // the third loss spends the last try; every turn after it answers what it is handed
    answers = true;
    w.box.finishTurns = true;
    await boxReconnects();
    // the room is told once, in its report thread, and the thread itself nothing (ISS-1105, ISS-1224)
    await expect.poll(() => toldTheRoom(), { timeout: 15_000 }).toBe(1);
    const [spent] = await rows<{ tries: number }>(sql`
      SELECT (output->>'tries')::int AS tries FROM support_actions
       WHERE room_id = ${roomId}::uuid AND kind = 'message_in' AND input->>'text' = ${text}`);
    expect(spent?.tries).toBe(3);
    // the box online warms the room's fresh session; its warm-up completing hands the queued
    // message on once more, and this time it is answered
    await warmSupportRoom(roomId, 'online');
    await w.untilLines((ls) => ls.some((l) => l.tmid === thread && l.text === `Answered: ${text}`));
    expect(handed(text)).toBe(4);
    const fourth = seen.filter((t) => t.messages.some((m) => m.text === text))[3];
    const warmed = w.box.turns.find(
      (t) => t.warmUp && t.sessionId === fourth?.sessionId && t.at <= Number(fourth?.at),
    );
    expect(warmed, 'the fourth hand-over follows a completed warm-up of its session').toBeTruthy();
    expect(await toldTheRoom()).toBe(1);
    expect(await toldInThread(thread)).toBe(0);
    const told = (await w.actions(roomId)).filter(
      (a) => a.kind === 'refused' && a.tool === 'turn_failed' && a.thread === thread,
    );
    expect(told).toHaveLength(1);
    // answered, it is handed on no more
    await coreStarts();
    await new Promise((r) => setTimeout(r, 500));
    expect(handed(text)).toBe(4);
  }, 120_000);

  it('a message whose thread got the session’s reply before the turn was lost is not handed on', async () => {
    const text = 'Thanks, what about stock?';
    const thread = await lostMidTurn(text, true);
    answers = true;
    w.box.finishTurns = true;
    await coreStarts();
    await boxReconnects();
    await new Promise((r) => setTimeout(r, 1_000));
    expect(handed(text)).toBe(1);
    expect(await toldInThread(thread)).toBe(0);
    const lines = (await w.chat.botLines()).filter((l) => l.tmid === thread);
    expect(lines.map((l) => l.text)).toEqual([`Answered: ${text}`]);
  }, 90_000);
});
