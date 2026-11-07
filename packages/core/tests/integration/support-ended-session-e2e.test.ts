// @direct-test-of packages/core/src/support/room-session.ts
// @direct-test-of packages/core/src/support/dispatch.ts
// @direct-test-of packages/core/src/support/warm.ts
// @direct-test-of packages/core/src/support/rooms.ts
// @direct-test-of packages/core/src/agent-sessions/chat-turn.ts
// @direct-test-of packages/core/src/pipeline/failure-patterns.ts

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { LAST_RESORT_LINES, STILL_QUEUED_LINE } from '../../src/conversations/last-resort.js';
import { db } from '../../src/db/client.js';
import { warmSupportRoom } from '../../src/support/warm.js';
import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import { SupportWorld, type Turn } from '../helpers/support-world.js';

// ISS-1101. epod's channel agent session 90306f67 kept the checkout it was made with after its box
// was rebound; every turn then failed to start, read failed, and was handed to the same session
// again by the warm sweep and the member messages' re-offers: 1,086 starts in 13 hours, every one
// lost, and a cancel changed nothing. A room's session that ended is never handed another turn: the
// room's next turn opens a new session in the checkout the binding names now. One that ended on a
// cause a retry meets again (its checkout is not on the box) is not tried again in that checkout:
// the room holds, the thread is told, and the binding naming another checkout lifts the hold.

const w = new SupportWorld();
let roomId = '';

beforeAll(async () => {
  await w.start();
  await w.bind();
  const [room] = await w.rooms();
  roomId = String(room?.id);
}, 120_000);

afterAll(() => w.stop());

const sessionOfRoom = async () => String((await w.rooms())[0]?.sessionId);
const statusOf = async (id: string) => {
  const [row] = await rows<{ status: string; failure_reason: string | null }>(
    sql`SELECT status, failure_reason FROM agent_sessions WHERE id = ${id}::uuid`,
  );
  return row;
};
const turnsOf = (id: string): Turn[] => w.box.turns.filter((t) => t.sessionId === id);

/** The box answers every member message of a turn; `fail` ends the next turns failed instead. */
function answerAll(): void {
  w.box.turnEnd = 'completed';
  w.box.failWith = null;
  w.box.model = async (turn, act) => {
    for (const m of turn.messages) {
      if (m.from === 'forge') continue;
      await act({ action: 'reply', thread: m.thread, text: `Answered: ${m.text}` });
    }
  };
}

describe('ISS-1101: a session whose box was rebound to another checkout', () => {
  it('runs its next turn in the checkout the binding names now, starting fresh, and is told', async () => {
    await w.untilWarm();
    const session = await sessionOfRoom();
    answerAll();
    await db.execute(
      sql`UPDATE runners SET repo_path = '/srv/moved' WHERE project_id = ${w.projectId}::uuid`,
    );
    const asked = await w.chat.say(w.chat.alice, 'Do you ship abroad?');
    await w.untilLines((ls) =>
      ls.some((l) => l.tmid === asked && l.text === 'Answered: Do you ship abroad?'),
    );
    const [turn] = turnsOf(session).filter((t) => t.messages.length > 0);
    expect(turn).toMatchObject({
      event: 'agent:start',
      repoPath: '/srv/moved',
      claudeSessionId: null,
    });
    const [said] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM agent_session_turns
       WHERE agent_session_id = ${session}::uuid
         AND content->'value'->>'content' LIKE '%its binding names /srv/moved now%'`);
    expect(said?.n).toBe(1);
  }, 60_000);
});

describe('ISS-1101: a session whose turn failed', () => {
  it('is never handed another turn: the next one opens a new session that answers', async () => {
    await w.untilWarm();
    const first = await sessionOfRoom();
    // the box fails the turn as it failed for epod: nothing classifies its words
    w.box.turnEnd = 'failed';
    w.box.model = async () => {};
    const asked = await w.chat.say(w.chat.alice, 'Is my order packed?');
    await expect
      .poll(async () => (await statusOf(first))?.status, { timeout: 15_000 })
      .toBe('failed');
    const handedBefore = turnsOf(first).length;
    answerAll();
    await w.untilLines(
      (ls) => ls.some((l) => l.tmid === asked && l.text === 'Answered: Is my order packed?'),
      30_000,
    );
    const next = await sessionOfRoom();
    expect(next).not.toBe(first);
    expect(turnsOf(first)).toHaveLength(handedBefore);
    expect((await statusOf(first))?.status).toBe('failed');
  }, 60_000);

  it('that a person cancelled is never handed another turn either', async () => {
    await w.settleWarm();
    const held = await sessionOfRoom();
    w.box.finishTurns = false;
    w.box.model = async () => {};
    const asked = await w.chat.say(w.chat.bob, 'Can I change my address?');
    await expect
      .poll(async () => (await statusOf(held))?.status, { timeout: 15_000 })
      .toBe('running');
    const cancelled = await api(w.owner, 'POST', `/api/agent-sessions/${held}/cancel`);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(await statusOf(held)).toMatchObject({
      status: 'failed',
      failure_reason: 'user_cancelled',
    });
    // a second cancel of the ended session changes nothing, as it did for epod
    expect((await api(w.owner, 'POST', `/api/agent-sessions/${held}/cancel`)).status).toBe(200);
    // the box kills the process the cancel aborted: its turn ends with no word
    w.box.lose(held);
    const handedBefore = turnsOf(held).length;
    w.box.finishTurns = true;
    answerAll();
    await w.chat.say(w.chat.bob, 'Hello?', asked);
    await w.untilLines((ls) => ls.some((l) => l.tmid === asked && l.text === 'Answered: Hello?'));
    expect(await sessionOfRoom()).not.toBe(held);
    expect(turnsOf(held)).toHaveLength(handedBefore);
  }, 60_000);
});

describe('ISS-1101: a turn that failed because its checkout is not on the box', () => {
  it('is not started again in that checkout: the room holds and the thread is told', async () => {
    await w.settleWarm();
    const held = await sessionOfRoom();
    const [runner] = await rows<{ repo_path: string }>(sql`
      SELECT repo_path FROM runners WHERE project_id = ${w.projectId}::uuid`);
    const gone = String(runner?.repo_path);
    w.box.turnEnd = 'failed';
    w.box.failWith = `chat turn for project refused: checkout ${gone} does not exist; the binding names /srv/elsewhere`;
    w.box.model = async () => {};
    const asked = await w.chat.say(w.chat.alice, 'Any stock left?');
    await expect
      .poll(async () => (await statusOf(held))?.failure_reason, { timeout: 15_000 })
      .toBe('workspace_preflight_failed');
    const started = w.box.turns.length;
    // the warm sweep and the message's re-offers hand nothing more while the binding is unchanged
    for (let i = 0; i < 4; i += 1) {
      await warmSupportRoom(roomId, 'sweep');
      await new Promise((r) => setTimeout(r, 1_500));
    }
    await w.chat.say(w.chat.alice, 'Hello again', asked);
    await new Promise((r) => setTimeout(r, 6_000));
    expect(w.box.turns.length, JSON.stringify(w.box.turns.slice(started))).toBe(started);
    const told = (await w.actions(roomId)).filter(
      (a) => a.kind === 'refused' && a.tool === 'turn_failed' && a.thread === asked,
    );
    // each message is recorded unanswered; the thread is told once while it waits
    expect(told.length).toBeGreaterThan(0);
    const lines = (await w.chat.botLines()).filter(
      (l) =>
        l.tmid === asked &&
        (l.text === STILL_QUEUED_LINE || l.text === LAST_RESORT_LINES.turn_failed),
    );
    expect(lines).toHaveLength(1);
  }, 60_000);

  it('runs again, on a new session in the new checkout, once the binding names another', async () => {
    const held = await sessionOfRoom();
    answerAll();
    await db.execute(
      sql`UPDATE runners SET repo_path = '/srv/elsewhere' WHERE project_id = ${w.projectId}::uuid`,
    );
    await warmSupportRoom(roomId, 'sweep');
    await w.untilLines((ls) => ls.some((l) => l.text === 'Answered: Any stock left?'), 30_000);
    const next = await sessionOfRoom();
    expect(next).not.toBe(held);
    const ran = turnsOf(next);
    expect(ran.length).toBeGreaterThan(0);
    expect(ran.every((t) => t.repoPath === '/srv/elsewhere')).toBe(true);
  }, 60_000);
});
