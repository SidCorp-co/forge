import { describe, expect, it } from 'vitest';
import { buildRocketChatHistoryToolset, formatConversationLines } from './context.js';
import { parseStreamMessage } from './ddp-client.js';
import { type RocketChatRestMessage, extractMessageText } from './rest-client.js';

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

  it('keeps the bot own replies when includeBot is set (thread dialogue)', () => {
    const out = formatConversationLines(
      [
        msg({ id: 'root', username: 'it_bot', text: 'Task: add API key for BurgerPrint' }),
        msg({ id: 'q', username: 'an', text: '@bot check this task' }),
        msg({ id: 'r', userId: 'bot', username: 'babo', text: 'could not find the task' }),
      ],
      { botUserId: 'bot', includeBot: true },
    );
    expect(out).toBe(
      '[it_bot]: Task: add API key for BurgerPrint\n[an]: @bot check this task\n[babo]: could not find the task',
    );
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

describe('extractMessageText', () => {
  it('flattens attachment title/text into the body (webhook bots post with empty msg)', () => {
    expect(
      extractMessageText({
        msg: '',
        attachments: [{ title: 'Job report', text: '*Job:* SyncInteractJob\n*Total:* 3' }],
      }),
    ).toBe('Job report\n*Job:* SyncInteractJob\n*Total:* 3');
  });

  it('keeps msg first and skips blank attachment fields', () => {
    expect(
      extractMessageText({ msg: 'look at this', attachments: [{ text: ' ' }, { text: 'quoted' }] }),
    ).toBe('look at this\nquoted');
  });

  it('is used by the DDP stream parser (quote content reaches the trigger text)', () => {
    const m = parseStreamMessage({
      _id: 'm1',
      rid: 'R1',
      msg: '[ ](https://rc/link) \nanalyze this @bot',
      u: { _id: 'u1', username: 'an' },
      attachments: [{ text: 'the quoted notification body' }],
      mentions: [{ _id: 'bot' }],
    });
    expect(m?.text).toContain('analyze this @bot');
    expect(m?.text).toContain('the quoted notification body');
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
