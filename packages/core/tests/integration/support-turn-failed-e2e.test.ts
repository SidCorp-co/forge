// @direct-test-of packages/core/src/support/last-resort.ts
// @direct-test-of packages/core/src/support/turn-retry.ts
// @direct-test-of packages/core/src/support/dispatch.ts
// @direct-test-of packages/core/src/support/delivery.ts
// @direct-test-of packages/core/src/agent-sessions/chat-turn.ts
// @direct-test-of packages/core/src/agent-sessions/events-routes.ts

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { dispatchChatTurn, sessionRowById } from '../../src/agent-sessions/index.js';
import { LAST_RESORT_LINES, STILL_QUEUED_LINE } from '../../src/conversations/last-resort.js';
import { RETRY_DELAYS_MS } from '../../src/support/turn-retry.js';
import { rows } from '../helpers/factories.js';
import { SupportWorld, type Turn } from '../helpers/support-world.js';

// REQ-75 r2, BC-11 and BC-18, as ISS-977 revised them: a support session's turn that fails on
// Forge's side is tried again by Forge with a short back-off, each try on the room's history, and
// only once the tries ran out is the thread told, in a plain Vietnamese line that says the assistant
// answers when it can; the message stays queued. A thread answered since is told again on a later
// failure. One session runs one turn at a time, and a transcript batch numbered from a stale base
// is told core's next seq. The world is support-room-e2e's: the real Rocket.Chat connection
// manager against a chat server and a box playing the session's Claude Code.

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

/** The lines of `thread` that are core's failed-turn lines, the old one asking to resend included. */
const failedLines = async (thread: string) =>
  (await w.chat.botLines()).filter(
    (l) =>
      l.tmid === thread &&
      (l.text === STILL_QUEUED_LINE || l.text === LAST_RESORT_LINES.turn_failed),
  );

/** The room's core records of `tool` in `thread`. */
const recorded = async (tool: string, thread: string) =>
  (await w.actions(roomId)).filter(
    (a) => a.kind === 'refused' && a.tool === tool && a.thread === thread,
  ) as { output: Record<string, unknown> }[];

/** The turns the session was handed `text` in. */
const handed = (seen: Turn[], text: string) =>
  seen.filter((t) => t.messages.some((m) => m.text === text)).length;

/**
 * The session's model for this block: a turn holding a message `failing` still owes a failure ends
 * failed, as a crash or a refused transcript does; any other turn answers every member message.
 */
function play(seen: Turn[], failing: Map<string, number>) {
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
      if (m.from === 'forge') continue;
      await act({ action: 'reply', thread: m.thread, text: `Answered: ${m.text}` });
    }
  };
}

describe("ISS-977: a turn that fails on Forge's side", () => {
  it('is tried again after a short back-off and answered, with no line posted and the try on the history', async () => {
    await w.untilWarm();
    const seen: Turn[] = [];
    play(seen, new Map([['Where is my parcel?', 1]]));
    const parcel = await w.chat.say(w.chat.alice, 'Where is my parcel?');
    await w.untilLines((ls) =>
      ls.some((l) => l.tmid === parcel && l.text === 'Answered: Where is my parcel?'),
    );
    expect(handed(seen, 'Where is my parcel?')).toBe(2);
    expect(await failedLines(parcel)).toEqual([]);
    const tries = await recorded('turn_retry', parcel);
    expect(tries).toHaveLength(1);
    expect(tries[0]?.output).toMatchObject({ try: 1, of: 3 });
    expect(String(tries[0]?.output.cause)).toMatch(/ended failed/);
    expect(await recorded('turn_failed', parcel)).toEqual([]);
  }, 60_000);

  it('tells the thread once its tries ran out, never asking to resend, and keeps the message queued', async () => {
    const seen: Turn[] = [];
    play(seen, new Map([['Refund please', 99]]));
    const refund = await w.chat.say(w.chat.bob, 'Refund please');
    await w.untilLines(
      (ls) => ls.some((l) => l.tmid === refund && l.text === STILL_QUEUED_LINE),
      60_000,
    );
    expect(handed(seen, 'Refund please')).toBe(3);
    expect((await failedLines(refund)).map((l) => l.text)).toEqual([STILL_QUEUED_LINE]);
    expect((await recorded('turn_retry', refund)).map((a) => a.output.try)).toEqual([1, 2, 3]);
    const told = await recorded('turn_failed', refund);
    expect(told).toHaveLength(1);
    expect(told[0]?.output).toMatchObject({ posted: true });
    // still queued: waiting for a turn, on the slow back-off, its three tries counted
    const [held] = await rows<{ delivered: boolean; tries: number; wait_s: number }>(sql`
      SELECT delivered_at IS NOT NULL AS delivered, (output->>'tries')::int AS tries,
             EXTRACT(EPOCH FROM ((output->>'retryAt')::timestamptz - now()))::int AS wait_s
        FROM support_actions
       WHERE room_id = ${roomId}::uuid AND kind = 'message_in' AND input->>'text' = 'Refund please'`);
    expect(held).toMatchObject({ delivered: false, tries: 3 });
    expect(held?.wait_s).toBeGreaterThan(Number(RETRY_DELAYS_MS[1]) / 1000);
    // the slow back-off holds it: nothing hands it on meanwhile, and nothing more is posted
    await new Promise((r) => setTimeout(r, 3_000));
    expect(handed(seen, 'Refund please')).toBe(3);
    expect(await failedLines(refund)).toHaveLength(1);
  }, 90_000);

  it('a held message goes with the next turn, and a thread answered since is told again when it fails again', async () => {
    const seen: Turn[] = [];
    const [{ id: refund } = { id: '' }] = await rows<{ id: string }>(sql`
      SELECT thread AS id FROM support_actions
       WHERE room_id = ${roomId}::uuid AND kind = 'message_in' AND input->>'text' = 'Refund please'`);
    play(seen, new Map([['Still there?', 99]]));
    // a new message in the thread is ready at once, and takes the held one along
    await w.chat.say(w.chat.bob, 'Any news?', refund);
    await w.untilLines((ls) =>
      ls.some((l) => l.tmid === refund && l.text === 'Answered: Refund please'),
    );
    expect(seen[0]?.messages.map((m) => m.text).sort()).toEqual(['Any news?', 'Refund please']);
    // that turn ends before the next message, so it goes as a turn of its own
    await expect
      .poll(async () => (await w.rooms())[0]?.sessionStatus === 'completed' && w.box.idle(), {
        timeout: 15_000,
      })
      .toBe(true);
    // answered, the thread's wait is over: its next failure is told again, under the same rule
    await w.chat.say(w.chat.bob, 'Still there?', refund);
    await expect
      .poll(() => failedLines(refund), { timeout: 60_000, interval: 250 })
      .toHaveLength(2);
    expect(handed(seen, 'Still there?')).toBe(3);
    expect((await failedLines(refund)).every((l) => l.text === STILL_QUEUED_LINE)).toBe(true);
    expect(await recorded('turn_failed', refund)).toHaveLength(2);
    // a turn that completes ends the slow back-off: the held message goes with it and is answered
    play(seen, new Map());
    await w.chat.say(w.chat.bob, 'Thanks', refund);
    await w.untilLines((ls) =>
      ls.some((l) => l.tmid === refund && l.text === 'Answered: Still there?'),
    );
  }, 120_000);
});

describe('ISS-977: one session, one turn', () => {
  it('two turns handed to one session at once start one, and refuse the other before it writes a seed row', async () => {
    await w.settleWarm();
    w.box.model = async () => {};
    w.box.turnEnd = 'completed';
    const session = await sessionRowById(sessionId);
    if (!session) throw new Error('no session');
    const seeds = async () =>
      (
        await rows<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM agent_session_events WHERE agent_session_id = ${sessionId}::uuid AND kind = 'seed'`,
        )
      )[0]?.n ?? 0;
    const before = await seeds();
    const turn = (message: string) =>
      dispatchChatTurn({
        session,
        project: { id: w.projectId, slug: 'p' },
        client: { deviceId: w.box.deviceId, migrated: false },
        message,
        preBuilt: true,
        actor: { type: 'system' },
      });
    const both = await Promise.allSettled([turn('first'), turn('second')]);
    const refused = both.filter((r) => r.status === 'rejected');
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toMatch(/SESSION_RUNNING/);
    expect(await seeds()).toBe(before + 1);
    await w.settleWarm();
  }, 60_000);

  it("a batch numbered into a seed row core wrote is refused naming core's next seq, which then lands", async () => {
    w.box.finishTurns = false;
    const seen: Turn[] = [];
    w.box.model = async (turn) => {
      seen.push(turn);
    };
    await w.chat.say(w.chat.alice, 'Hello again');
    await expect.poll(() => seen.length, { timeout: 15_000 }).toBe(1);
    const [top] = await rows<{ max: number }>(
      sql`SELECT max(seq)::int AS max FROM agent_session_events WHERE agent_session_id = ${sessionId}::uuid`,
    );
    const seed = Number(top?.max);
    // a box that numbered this turn from the base before core's last seed row, as one restarted
    // beside a second turn did
    const post = (seq: number) =>
      fetch(`${w.core.base}/api/agent-sessions/${sessionId}/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${w.box.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [{ seq, kind: 'stdout', data: { line: { type: 'assistant' } } }],
        }),
      });
    const clash = await post(seed);
    expect(clash.status).toBe(409);
    const body = (await clash.json()) as { code: string; details: Record<string, unknown> };
    expect(body.code).toBe('SEQ_TAKEN_BY_CORE');
    expect(body.details).toMatchObject({ seq: seed, kind: 'seed', nextSeq: seed + 1 });
    const landed = await post(seed + 1);
    expect(landed.status).toBe(200);
    expect(await landed.json()).toMatchObject({ accepted: 1 });
    w.box.finishTurns = true;
    await w.box.finish(sessionId, 'claude-retry');
  }, 60_000);
});
