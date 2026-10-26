import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { rows } from '../helpers/factories.js';
import { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld, type Turn } from '../helpers/support-world.js';

// REQ-75 BC-11, in real time: a member's message goes to the room's session the moment it is
// recorded, into a Claude Code process kept warm on the box, and the room read shows how long each
// answer took from the Rocket.Chat message's own timestamp. The world is support-room-e2e's.

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

interface Latency {
  measured: number;
  p50Ms: number | null;
  p95Ms: number | null;
  byPath: Record<'start' | 'send' | 'inject', { measured: number }>;
}
const latency = async () => (await w.rooms())[0]?.latency as Latency;

/** The model answers every member message in its thread. */
function answerAll(): void {
  w.box.model = async (turn, act) => {
    for (const m of turn.messages)
      if (m.from !== 'forge')
        await act({ action: 'reply', thread: m.thread, text: `Re: ${m.text}` });
  };
}

describe('REQ-75: a support group in real time (BC-11)', () => {
  it('hands a member’s message to the warm session at once, never on a timer', async () => {
    await w.untilWarm();
    answerAll();
    const asked = w.box.asked().length;
    const said = Date.now();
    const id = await w.chat.say(w.chat.alice, 'Can I change my invoice address?');
    await expect
      .poll(() => w.box.asked().length, { timeout: 10_000, interval: 10 })
      .toBe(asked + 1);
    const turn = w.box.asked()[asked] as Turn;
    // core hands it on as it is recorded; the 2s recovery sweep is not running in this world at all
    expect(turn.at - said).toBeLessThan(1_000);
    expect(turn).toMatchObject({ event: 'agent:send', keepResident: true });
    await w.untilLines((ls) => ls.some((l) => l.tmid === id && l.text.startsWith('Re:')));
    // the latency is settled as the reply's act returns, just after the line is posted
    await expect
      .poll(async () => (await latency()).byPath.send.measured, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(1);
  });

  it('reads each answer’s latency from the Rocket.Chat timestamp, and shows p50 and p95 in the room read', async () => {
    if (!(w.chat instanceof StandInRocketChat)) return;
    answerAll();
    // the server stamped this message 4s before the stream carried it: the wait counts from the stamp
    const id = await w.chat.sayAt(Date.now() - 4_000, w.chat.bob, 'Where is order 1234?');
    await w.untilLines((ls) => ls.some((l) => l.tmid === id && l.text.startsWith('Re:')));
    await expect.poll(async () => (await latency()).measured, { timeout: 5_000 }).toBe(2);
    const [late] = await rows<{ ms: number }>(sql`
      SELECT (output->>'latencyMs')::int AS ms FROM support_actions
       WHERE room_id = ${roomId}::uuid AND kind = 'message_in' AND input->>'text' = 'Where is order 1234?'`);
    expect(late?.ms).toBeGreaterThanOrEqual(4_000);
    expect(late?.ms).toBeLessThan(10_000);
    const l = await latency();
    expect(l.p95Ms).toBeGreaterThanOrEqual(4_000);
    expect(l.p50Ms).toBeLessThan(4_000);
  });

  it('writes a message that arrives mid-turn into the running turn, and settles it as the turn ends', async () => {
    await w.untilWarm();
    answerAll();
    w.box.finishTurns = false;
    const started = w.box.asked().length;
    const first = await w.chat.say(w.chat.alice, 'My export is empty');
    await expect.poll(() => w.box.asked().length, { timeout: 10_000 }).toBe(started + 1);
    const before = started + 1;
    const said = Date.now();
    const id = await w.chat.say(w.chat.alice, 'It has only the header row', first);
    await expect
      .poll(() => w.box.asked().length, { timeout: 5_000, interval: 10 })
      .toBe(before + 1);
    const written = w.box.asked()[before] as Turn;
    expect(written).toMatchObject({ event: 'session.send', sessionId });
    expect(written.at - said).toBeLessThan(1_000);
    await w.untilLines((ls) => ls.some((l) => l.tmid === first && l.text.includes('header row')));
    w.box.finishTurns = true;
    await w.box.finish(sessionId, 'claude-rt-1');
    // the turn's end settles it, applied: no sweep is needed, and it is never handed over again
    const ledger = async () =>
      (
        await rows<{ path: string; settled: boolean | null; ms: number | null }>(sql`
          SELECT output->>'path' AS path, (output->>'injectSettled')::boolean AS settled,
                 (output->>'latencyMs')::int AS ms
            FROM support_actions WHERE room_id = ${roomId}::uuid AND external_id = ${id}`)
      )[0];
    await expect.poll(async () => (await ledger())?.settled, { timeout: 5_000 }).toBe(true);
    expect(await ledger()).toMatchObject({ path: 'inject' });
    expect((await ledger())?.ms).toBeGreaterThanOrEqual(0);
    expect((await latency()).byPath.inject.measured).toBe(1);
    await w.untilWarm();
    expect(w.box.asked().filter((t) => t.text.includes('It has only the header row'))).toHaveLength(
      1,
    );
  });

  it('tells a warm session the tools a grant adds, and a busy one once its turn has ended', async () => {
    const { warmProjectRooms } = await import('../../src/support/warm.js');
    const { warmColdRooms } = await import('../../src/support/index.js');
    const grant = (name: string) =>
      db.execute(sql`UPDATE integration_bindings SET config = jsonb_set(config, '{tools}',
        (config->'tools') || ${JSON.stringify([
          {
            name,
            kind: 'diagnose',
            method: 'GET',
            path: '/customers/{id}',
            summary: `read a customer (${name})`,
            params: { id: { in: 'path', description: 'the customer id', pattern: '[0-9]{1,10}' } },
          },
        ])}::jsonb) WHERE connection_id = ${w.apiConnectionId}::uuid`);
    const toldOf = (name: string) =>
      w.box.turns.filter((t) => t.warmUp && t.text.includes(`- ${name} (diagnose)`)).length;
    await w.untilWarm();
    await grant('lookup_customer');
    await warmProjectRooms(w.projectId);
    await expect.poll(() => toldOf('lookup_customer'), { timeout: 5_000 }).toBe(1);
    await w.untilWarm();
    const turns = w.box.turns.length;
    await warmProjectRooms(w.projectId);
    expect(w.box.turns.length, 'nothing changed: no turn').toBe(turns);

    answerAll();
    await w.settleWarm();
    w.box.finishTurns = false;
    const started = w.box.asked().length;
    await w.chat.say(w.chat.bob, 'Hello, anyone there?');
    await expect.poll(() => w.box.asked().length, { timeout: 5_000 }).toBe(started + 1);
    await grant('lookup_invoice');
    await warmProjectRooms(w.projectId);
    expect(toldOf('lookup_invoice'), 'a running turn is not interrupted').toBe(0);
    w.box.finishTurns = true;
    await w.box.finish(sessionId, 'claude-rt-2');
    await w.untilWarm();
    await warmColdRooms();
    await expect.poll(() => toldOf('lookup_invoice'), { timeout: 5_000 }).toBe(1);
    await w.untilWarm();
  });

  it('keeps a support group’s session resident past the idle residency that closes other chats', async () => {
    const { closeIdleResidents } = await import('../../src/jobs/park-deadline.js');
    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    await withKernelMarker(db, async (tx) => {
      await tx.execute(sql`UPDATE agent_sessions SET runtime_state = 'awaiting_input',
        last_heartbeat_at = now() - interval '2 hours', updated_at = now() - interval '2 hours'
        WHERE id = ${sessionId}::uuid`);
    });
    expect(await closeIdleResidents(new Date(), { projectId: w.projectId })).toBe(0);
    const [s] = await rows<{ runtime_state: string }>(
      sql`SELECT runtime_state FROM agent_sessions WHERE id = ${sessionId}::uuid`,
    );
    expect(s?.runtime_state).toBe('awaiting_input');
  });

  it('warms the session again when its box comes back online', async () => {
    // a turn still running holds a live process: only an idle session is warmed again
    await w.untilWarm();
    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    await withKernelMarker(db, async (tx) => {
      await tx.execute(sql`UPDATE devices SET status = 'offline' WHERE id = ${w.box.deviceId}`);
    });
    const warmed = w.box.turns.filter((t) => t.warmUp).length;
    const beat = await fetch(`${w.core.base}/api/devices/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${w.box.token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(beat.status, await beat.text()).toBe(200);
    await settleOutbox();
    await expect
      .poll(() => w.box.turns.filter((t) => t.warmUp).length, { timeout: 10_000 })
      .toBe(warmed + 1);
  });
});
