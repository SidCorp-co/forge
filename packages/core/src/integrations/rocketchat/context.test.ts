import { describe, expect, it } from 'vitest';
import { buildRocketChatHistoryToolset, formatConversationLines } from './context.js';
import type { RocketChatRestMessage } from './rest-client.js';

const msg = (over: Partial<RocketChatRestMessage>): RocketChatRestMessage => ({
  id: 'm1',
  text: 'hello',
  userId: 'u1',
  username: 'an',
  ts: '2026-07-03T10:00:00.000Z',
  isSystem: false,
  ...over,
});

describe('formatConversationLines', () => {
  it('renders [user]: text lines and drops system/bot-own/empty/excluded', () => {
    const out = formatConversationLines(
      [
        msg({ id: 'a', username: 'an', text: 'deploy is failing' }),
        msg({ id: 'b', userId: 'bot', username: 'forge-bot', text: 'bot reply' }),
        msg({ id: 'c', username: 'binh', text: '  ' }),
        msg({ id: 'd', username: 'sys', isSystem: true, text: 'joined' }),
        msg({ id: 'e', username: 'chi', text: '@forge-bot please file an issue' }),
      ],
      { botUserId: 'bot', excludeMessageId: 'e' },
    );
    expect(out).toBe('[an]: deploy is failing');
  });

  it('dedupes overlapping room+thread messages by id', () => {
    const out = formatConversationLines(
      [msg({ id: 'a', text: 'one' }), msg({ id: 'a', text: 'one' }), msg({ id: 'b', text: 'two' })],
      { botUserId: 'bot' },
    );
    expect(out).toBe('[an]: one\n[an]: two');
  });

  it('returns null when nothing remains', () => {
    expect(formatConversationLines([msg({ userId: 'bot' })], { botUserId: 'bot' })).toBeNull();
  });

  it('keeps the tail when over the block cap', () => {
    const big = Array.from({ length: 40 }, (_, i) =>
      msg({ id: `m${i}`, text: `${i}-${'x'.repeat(590)}` }),
    );
    const out = formatConversationLines(big, { botUserId: 'bot' });
    expect(out).not.toBeNull();
    expect(out?.startsWith('… [older messages truncated]')).toBe(true);
    expect(out).toContain('39-');
  });
});

describe('buildRocketChatHistoryToolset', () => {
  const auth = { serverUrl: 'https://rc.invalid', authToken: 't', userId: 'bot' };

  it('advertises a single rocketchat_history tool', () => {
    const set = buildRocketChatHistoryToolset(auth, 'RID1');
    expect(set.tools.map((t) => t.function.name)).toEqual(['rocketchat_history']);
  });

  it('caps calls per turn with a JSON error', async () => {
    const set = buildRocketChatHistoryToolset(auth, 'RID1');
    // fetch against rc.invalid fails → empty message lists, but calls still count.
    await set.execute('rocketchat_history', '{}');
    await set.execute('rocketchat_history', '{}');
    await set.execute('rocketchat_history', '{}');
    const out = JSON.parse(await set.execute('rocketchat_history', '{}'));
    expect(out.error).toMatch(/capped at 3 calls/);
  });

  it('rejects invalid JSON args without throwing', async () => {
    const set = buildRocketChatHistoryToolset(auth, 'RID1');
    const out = JSON.parse(await set.execute('rocketchat_history', '{nope'));
    expect(out.error).toMatch(/valid JSON/);
  });
});
