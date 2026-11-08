import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { rows } from '../helpers/factories.js';
import { SupportWorld } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/service.ts
// @direct-test-of packages/core/src/support/dispatch.ts
// @direct-test-of packages/core/src/support/turn-retry.ts
// @direct-test-of packages/core/src/support/prompt.ts
//
// ISS-942: a room agent's silence wrote nothing and a reply carried no reason, so a wrong silence
// or a wrong answer could not be found and the room's policy tuned. support.silent posts nothing and
// records its reason on the room and the thread; a reply keeps its one-line why.
//
// ISS-1007 and ISS-764 (a): a turn that completed with nothing said for a message it was handed
// (a 1-3 s exit, a turn declared done while the process still worked) read as answered, so the
// person waited with no failure and no retry recorded. It is handed again until its tries run out,
// then recorded on its thread as unanswered, by name. ISS-764 (d): a thread handed several messages
// in one turn says so on each, so the one result covers them all.

const w = new SupportWorld();

beforeAll(async () => {
  await w.start();
  await w.bind();
}, 120_000);

afterAll(() => w.stop());

const roomId = async () => String((await w.rooms())[0]?.id);

describe('ISS-942: a silence and a reply each keep their reason on the room', () => {
  it('records a silence with its reason, posting nothing, and a reply with its why', async () => {
    await w.settleWarm();
    const done: Record<string, unknown>[] = [];
    w.box.model = async (turn, act) => {
      for (const m of turn.messages) {
        if (m.from === 'forge') continue;
        done.push(
          m.text.includes('thanks')
            ? await act({
                action: 'silent',
                thread: m.thread,
                message: m.message,
                reason: 'thanks, nothing asked',
              })
            : await act({
                action: 'reply',
                thread: m.thread,
                text: 'The export runs nightly at two.',
                why: 'asked when the export runs',
              }),
        );
      }
    };
    const thanks = await w.chat.say(w.chat.alice, 'thanks all');
    await expect.poll(() => done.length, { timeout: 15_000 }).toBe(1);
    const asked = await w.chat.say(w.chat.alice, 'When does the export run?');
    await expect.poll(() => done.length, { timeout: 15_000 }).toBe(2);
    expect(
      done.every((d) => d.isError === false),
      JSON.stringify(done),
    ).toBe(true);
    expect(await w.linesIn(thanks)).toEqual([]);
    const actions = await w.actions(await roomId());
    expect(actions).toContainEqual(
      expect.objectContaining({
        kind: 'silent',
        thread: thanks,
        input: { reason: 'thanks, nothing asked', message: thanks },
      }),
    );
    expect(actions).toContainEqual(
      expect.objectContaining({
        kind: 'reply',
        thread: asked,
        input: expect.objectContaining({ why: 'asked when the export runs' }),
      }),
    );
    // the silence is a line on the thread's conversation too
    const [line] = await rows<{ content: string }>(sql`
      SELECT m.content FROM conversation_messages m
       WHERE m.role = 'system' AND m.content = 'stayed silent: thanks, nothing asked'`);
    expect(line?.content).toBe('stayed silent: thanks, nothing asked');
  });
});

describe('ISS-1007: a completed turn that said nothing for a message is not read as an answer', () => {
  it('hands the message again, then records it unanswered by name once its tries run out', async () => {
    await w.settleWarm();
    const handed: string[] = [];
    // the 1-3 s exits of 2026-11-01: the turn completes and nothing is said for the message
    w.box.idleTurnsAct = false;
    w.box.model = async (turn) => {
      for (const m of turn.messages) if (m.from !== 'forge') handed.push(m.message ?? '');
    };
    const id = await w.chat.say(w.chat.alice, 'Can you research the channel feature?');
    await expect.poll(() => handed.length, { timeout: 60_000, interval: 200 }).toBe(3);
    const unanswered = () =>
      rows<{ output: { messages: string[]; cause: string } }>(sql`
        SELECT output FROM support_actions
         WHERE thread = ${id} AND kind = 'refused' AND tool = 'turn_unanswered'`);
    await expect.poll(async () => (await unanswered()).length, { timeout: 15_000 }).toBe(1);
    expect((await unanswered())[0]?.output.cause).toContain('support.silent');
    const retries = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM support_actions
       WHERE thread = ${id} AND kind = 'refused' AND tool = 'turn_retry'`);
    expect(retries[0]?.n).toBe(2);
    // no line tells the room it broke: the session ran and chose to say nothing
    expect(await w.linesIn(id)).toEqual([]);
    await w.settleWarm();
    expect(handed).toEqual([id, id, id]);
    w.box.idleTurnsAct = true;
  });

  it('hands nothing again from a turn that acted, though it posted nothing for the message', async () => {
    await w.settleWarm();
    const handed: string[] = [];
    w.box.model = async (turn, act) => {
      for (const m of turn.messages) {
        if (m.from === 'forge') continue;
        handed.push(m.message ?? '');
        await act({ action: 'thread', thread: m.thread });
      }
    };
    const id = await w.chat.say(w.chat.alice, 'Morning all');
    await expect.poll(() => handed.length, { timeout: 15_000 }).toBe(1);
    await w.settleWarm();
    expect(handed).toEqual([id]);
    const retries = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM support_actions WHERE thread = ${id} AND tool = 'turn_retry'`);
    expect(retries[0]?.n).toBe(0);
  });
});
