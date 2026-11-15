import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import { refusalCodes, SupportWorld } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/routing.ts
// @direct-test-of packages/core/src/support/acts.ts
// @direct-test-of packages/core/src/support/tool.ts
// @direct-test-of packages/core/src/support/routes.ts
// @direct-test-of packages/core/src/support/turn-record.ts

const w = new SupportWorld();

beforeAll(async () => {
  await w.start();
  await w.bind();
}, 120_000);

afterAll(() => w.stop());

const roomId = async () => String((await w.rooms())[0]?.id);

// ISS-1243: a room agent chose the project and whether to answer from the message text alone and
// recorded nothing of the choice, so misrouting was inferred from the outcome. support.decide keeps
// each message's routing decision on its turn: the project, the signals, the confidence, and
// answer, gather, ask or silent with why; a turn that recorded none reads so, never as a silence.
describe('ISS-1243: every turn records its routing decision, read on the turn and counted', () => {
  it('keeps a decided silence and a decided answer on their turns, counted by decision', async () => {
    await w.settleWarm();
    const [home] = await rows<{ slug: string }>(
      sql`SELECT slug FROM projects WHERE id = ${w.projectId}::uuid`,
    );
    const slug = String(home?.slug);
    const done: Record<string, unknown>[] = [];
    w.box.model = async (turn, act) => {
      for (const m of turn.messages) {
        if (m.from === 'forge') continue;
        if (m.text.includes('cheers')) {
          done.push(
            await act({
              action: 'decide',
              thread: m.thread,
              message: m.message,
              decision: 'silent',
              signals: ['message'],
              confidence: 'high',
              why: 'thanks to a colleague, nothing asked',
            }),
          );
          continue;
        }
        done.push(
          await act({
            action: 'decide',
            thread: m.thread,
            message: m.message,
            decision: 'answer',
            project: slug,
            signals: ['message', 'sender', 'thread_history', 'thread_history'],
            confidence: 'medium',
            why: 'asks when the invoice export runs, which this project owns',
          }),
        );
        done.push(
          await act({
            action: 'reply',
            thread: m.thread,
            text: 'It runs nightly at two.',
            why: 'asked when it runs',
          }),
        );
      }
    };
    const cheers = await w.chat.say(w.chat.alice, 'cheers team');
    await expect.poll(() => done.length, { timeout: 15_000 }).toBe(1);
    const asked = await w.chat.say(w.chat.alice, 'When does the invoice export run?');
    await expect.poll(() => done.length, { timeout: 15_000 }).toBe(3);
    expect(
      done.every((d) => d.isError === false),
      JSON.stringify(done),
    ).toBe(true);
    await w.settleWarm();
    const room = await roomId();
    const actions = await w.actions(room);
    // the decided silence is the message's stated silence: nothing posted, nothing handed again
    expect(await w.linesIn(cheers)).toEqual([]);
    expect(actions).toContainEqual(
      expect.objectContaining({
        kind: 'silent',
        thread: cheers,
        input: { reason: 'thanks to a colleague, nothing asked', message: cheers },
      }),
    );
    const retries = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM support_actions WHERE thread = ${cheers} AND tool = 'turn_retry'`);
    expect(retries[0]?.n).toBe(0);
    const decided = actions.filter((a) => a.kind === 'routing_decided');
    expect(decided.map((a) => [a.thread, a.input])).toEqual([
      [
        cheers,
        {
          decision: 'silent',
          project: null,
          signals: ['message'],
          confidence: 'high',
          why: 'thanks to a colleague, nothing asked',
          message: cheers,
        },
      ],
      [
        asked,
        {
          decision: 'answer',
          project: slug,
          signals: ['message', 'sender', 'thread_history'],
          confidence: 'medium',
          why: 'asks when the invoice export runs, which this project owns',
          message: asked,
        },
      ],
    ]);
    // read on the turn record that made it
    const turn = decided[1]?.turn as { id: string } | null;
    const base = `/api/projects/${w.projectId}/support/rooms/${room}/turns`;
    const read = await api(w.owner, 'GET', `${base}/${String(turn?.id)}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect((read.body.turn as Record<string, unknown>).routing).toEqual({
      recorded: true,
      decisions: [
        expect.objectContaining({
          thread: asked,
          decision: 'answer',
          project: slug,
          confidence: 'medium',
        }),
      ],
    });
    // and counted across the room's turns
    const listed = await api(w.owner, 'GET', `${base}?thread=${encodeURIComponent(asked)}`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.turns).toEqual([expect.objectContaining({ decision: 'answer' })]);
    expect(listed.body.decisions).toEqual({
      answer: 1,
      gather: 0,
      ask: 0,
      silent: 0,
      undecidedTurns: 0,
    });
    const all = await api(w.owner, 'GET', base);
    expect(all.body.decisions).toMatchObject({ answer: 1, silent: 1 });
  });

  it('reads a turn that recorded no decision as such, never as a silence, and refuses an unfollowed project', async () => {
    await w.settleWarm();
    const done: Record<string, unknown>[] = [];
    w.box.model = async (turn, act) => {
      const m = turn.messages.find((x) => x.from !== 'forge');
      if (!m) return;
      done.push(
        await act({
          action: 'decide',
          thread: m.thread,
          decision: 'answer',
          project: 'no-such-project',
          signals: ['message'],
          confidence: 'low',
          why: 'guessing a project',
        }),
      );
      done.push(
        await act({ action: 'reply', thread: m.thread, text: 'Yes, it is.', why: 'asked' }),
      );
    };
    const asked = await w.chat.say(w.chat.alice, 'Is the export on?');
    await expect.poll(() => done.length, { timeout: 15_000 }).toBe(2);
    expect(refusalCodes(done[0])).toEqual(['OPS_OUT_OF_SCOPE']);
    await w.settleWarm();
    const room = await roomId();
    const reply = (await w.actions(room)).find((a) => a.kind === 'reply' && a.thread === asked);
    expect(
      (await w.actions(room)).filter((a) => a.kind === 'routing_decided' && a.thread === asked),
    ).toEqual([]);
    const turn = reply?.turn as { id: string } | null;
    const base = `/api/projects/${w.projectId}/support/rooms/${room}/turns`;
    const read = await api(w.owner, 'GET', `${base}/${String(turn?.id)}`);
    expect((read.body.turn as Record<string, unknown>).routing).toEqual({
      recorded: false,
      decisions: [],
      reads: 'no decision recorded',
    });
    const listed = await api(w.owner, 'GET', `${base}?thread=${encodeURIComponent(asked)}`);
    expect(listed.body.turns).toEqual([expect.objectContaining({ decision: null })]);
    expect(listed.body.decisions).toEqual({
      answer: 0,
      gather: 0,
      ask: 0,
      silent: 0,
      undecidedTurns: 1,
    });
  });
});
