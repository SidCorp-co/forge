import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { SupportWorld } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/react-act.ts
// @direct-test-of packages/core/src/support/react-routes.ts
// @direct-test-of packages/core/src/support/acts.ts
//
// ISS-1475 (owner 2026-11-26): a room agent acknowledges a message by a reaction, never by a line
// saying it is checking. support.react sets one reaction from a short set on a message of its own
// thread, posts no text, refuses a message outside the thread by name, and a repeat sets nothing.

const w = new SupportWorld();

beforeAll(async () => {
  await w.start();
  await w.bind();
}, 120_000);

afterAll(() => w.stop());

describe('ISS-1475: support.react', () => {
  it('reacts once on a message of its thread, refuses one outside it, and posts no text', async () => {
    await w.settleWarm();
    const done: Record<string, Record<string, unknown>> = {};
    let other = '';
    w.box.model = async (turn, act) => {
      for (const m of turn.messages) {
        if (m.from === 'forge' || !m.message) continue;
        if (m.text.includes('other')) continue;
        const react = { action: 'react', thread: m.thread, message: m.message };
        done.first = await act({ ...react, emoji: 'hourglass_flowing_sand' });
        done.repeat = await act({ ...react, emoji: 'hourglass_flowing_sand' });
        done.outside = await act({ ...react, message: other || 'NoSuchMessage1', emoji: 'eyes' });
        done.emoji = await act({ ...react, emoji: 'rocket' });
      }
    };
    other = await w.chat.say(w.chat.alice, 'a message in the other thread');
    const asked = await w.chat.say(w.chat.alice, 'Why does the sync fail?');
    await expect.poll(() => Object.keys(done).length, { timeout: 20_000 }).toBe(4);
    expect(done.first?.isError, JSON.stringify(done.first)).toBe(false);
    expect(done.repeat?.isError, JSON.stringify(done.repeat)).toBe(false);
    expect(JSON.stringify(done.repeat)).toContain('"already":true');
    // the message of another thread and the shape outside the set are refused by name
    expect(JSON.stringify(done.outside)).toContain('SUPPORT_REACT_MESSAGE_UNKNOWN');
    expect(done.emoji?.isError).toBe(true);
    // the stand-in chat server records each reaction it takes
    const taken = (w.chat as unknown as { reactions: { messageId: string; emoji: string }[] })
      .reactions;
    const mine = taken.filter((r) => r.messageId === asked && r.emoji === 'hourglass_flowing_sand');
    expect(mine).toHaveLength(1);
    expect(await w.linesIn(asked)).toEqual([]);
  });
});
