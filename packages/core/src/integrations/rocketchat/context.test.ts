import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatToolset } from '../../assistant/tools/mcp-adapter.js';
import {
  buildRocketChatHistoryToolset,
  buildRocketChatQuoteContextToolset,
  extractQuotedMessageIds,
  formatConversationLines,
} from './context.js';
import { parseStreamMessage } from './ddp-client.js';
import { extractMessageText, type RocketChatRestMessage } from './rest-client.js';

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
      { botUserId: 'bot', excludeMessageIds: ['e'] },
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

describe('extractQuotedMessageIds', () => {
  it('pulls quoted ids from quote-links, deduped, excluding the trigger/thread ids', () => {
    const ids = extractQuotedMessageIds(
      [
        '[ ](https://chat.example.co/group/dodgeprint-issues?msg=FrfkFvtdWNa6MGnMr)\n@babo check this',
        'see also https://chat.example.co/group/x?msg=FrfkFvtdWNa6MGnMr and https://chat.example.co/channel/y?msg=AAA111',
        undefined,
      ],
      new Set(['AAA111']),
    );
    expect(ids).toEqual(['FrfkFvtdWNa6MGnMr']);
  });

  it('caps the number of quoted fetches', () => {
    const texts = Array.from({ length: 10 }, (_, i) => `x ?msg=ID${i} y`);
    expect(extractQuotedMessageIds(texts, new Set()).length).toBe(3);
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

  it('keeps the title link inline — the URL is often the only place the entity id appears', () => {
    expect(
      extractMessageText({
        msg: '@chuongld commented',
        attachments: [
          {
            title: '[Supplier] Add API key for BurgerPrint',
            title_link: 'https://hub.example.co/tasks?projectId=53&task=12608',
            text: 'please check',
          },
        ],
      }),
    ).toBe(
      '@chuongld commented\n[Supplier] Add API key for BurgerPrint (https://hub.example.co/tasks?projectId=53&task=12608)\nplease check',
    );
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
  const body = async (p: ReturnType<ChatToolset['execute']>) => {
    const r = await p;
    return { ...JSON.parse((r.content[0] as { text: string }).text), isError: r.isError };
  };

  it('advertises a single rocketchat_history tool', () => {
    const set = buildRocketChatHistoryToolset(auth, 'RID1');
    expect(set.tools.map((t) => t.function.name)).toEqual(['rocketchat_history']);
  });

  it('caps calls per turn with a JSON error', async () => {
    const set = buildRocketChatHistoryToolset(auth, 'RID1');
    // cm:why the per-turn counter is what is under test, not the fetch: rc.invalid fails and yields empty message lists, and a failed call still counts against the cap
    await set.execute('rocketchat_history', '{}');
    await set.execute('rocketchat_history', '{}');
    await set.execute('rocketchat_history', '{}');
    const out = await body(set.execute('rocketchat_history', '{}'));
    expect(out.error).toMatch(/capped at 3 calls/);
    expect(out.isError).toBe(true);
  });

  it('rejects invalid JSON args without throwing', async () => {
    const set = buildRocketChatHistoryToolset(auth, 'RID1');
    const out = await body(set.execute('rocketchat_history', '{nope'));
    expect(out.error).toMatch(/valid JSON/);
    expect(out.isError).toBe(true);
  });
});

describe('buildRocketChatQuoteContextToolset (ISS-1087)', () => {
  const auth = { serverUrl: 'https://chat.example.com', authToken: 't', userId: 'bot' };
  const ts = (n: number) => `2026-09-17T10:00:${String(n).padStart(2, '0')}.000Z`;
  const raw = (id: string, n: number, over: Record<string, unknown> = {}) => ({
    _id: id,
    rid: 'R1',
    msg: `text of ${id}`,
    ts: ts(n),
    u: { _id: 'u1', username: 'alice' },
    ...over,
  });
  /** The room: m1..m9 at one second apart; A5 is the anchor most cases quote. */
  const room = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => raw(`m${n}`, n));
  const calls: string[] = [];
  const serve = (
    messages: Record<string, Record<string, unknown>> = {},
    beside: (side: 'before' | 'after', t: string, count: number) => Record<string, unknown>[] = (
      side,
      t,
      count,
    ) =>
      side === 'after'
        ? room.filter((m) => m.ts > t).slice(0, count)
        : room.filter((m) => m.ts < t).slice(-count),
  ) => {
    calls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input);
        const path = url.pathname.replace('/api/v1/', '');
        calls.push(path);
        const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
        if (path === 'chat.getMessage') {
          const m = messages[url.searchParams.get('msgId') ?? ''];
          return m
            ? ok({ message: m })
            : ({ ok: false, json: async () => ({}) } as unknown as Response);
        }
        if (path === 'channels.messages') {
          const q = JSON.parse(url.searchParams.get('query') ?? '{}') as {
            ts: Record<string, { $date: string }>;
          };
          const side = '$gt' in q.ts ? 'after' : 'before';
          const t = (q.ts.$gt ?? q.ts.$lt)?.$date ?? '';
          return ok({ messages: beside(side, t, Number(url.searchParams.get('count'))) });
        }
        if (path === 'chat.getThreadMessages') {
          return ok({
            messages: [
              raw('t2', 12, { tmid: 'T1' }),
              raw('t3', 13, { tmid: 'T1' }),
              raw('t4', 14, { tmid: 'T1' }),
              raw('t5', 15, { tmid: 'T1' }),
              raw('t6', 16, { tmid: 'T1' }),
            ],
          });
        }
        return { ok: false, json: async () => ({}) } as unknown as Response;
      }),
    );
  };
  const body = async (set: ChatToolset, id: string): Promise<Record<string, unknown>> => {
    const r = await set.execute('rocketchat_quote_context', JSON.stringify({ messageId: id }));
    const parsed = JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;
    return { ...parsed, isError: r.isError };
  };

  afterEach(() => vi.unstubAllGlobals());

  it('advertises rocketchat_quote_context (criterion 24)', () => {
    const set = buildRocketChatQuoteContextToolset(auth, 'R1');
    expect(set.tools.map((t) => t.function.name)).toEqual(['rocketchat_quote_context']);
  });

  it('returns the anchor with two before and two after, oldest first (criterion 25)', async () => {
    serve({ m5: raw('m5', 5) });
    const out = await body(buildRocketChatQuoteContextToolset(auth, 'R1'), 'm5');
    expect(out.isError).toBeUndefined();
    expect(out.anchor).toBe('m5');
    expect((out.messages as Array<{ id: string }>).map((m) => m.id)).toEqual([
      'm3',
      'm4',
      'm5',
      'm6',
      'm7',
    ]);
    expect((out.messages as Array<Record<string, unknown>>)[0]).toEqual({
      id: 'm3',
      user: 'alice',
      ts: ts(3),
      text: 'text of m3',
    });
  });

  // cm:guard neighbours come from the THREAD when the anchor sits in one: the room stream around the same instant is other people's conversation (criterion 26).
  it('takes a thread anchor’s neighbours from the thread, not the room (criterion 26)', async () => {
    serve({ t4: raw('t4', 14, { tmid: 'T1' }), T1: raw('T1', 11) });
    const out = await body(buildRocketChatQuoteContextToolset(auth, 'R1'), 't4');
    expect((out.messages as Array<{ id: string }>).map((m) => m.id)).toEqual([
      't2',
      't3',
      't4',
      't5',
      't6',
    ]);
    expect(calls).not.toContain('channels.messages');
  });

  it('refuses a third distinct target naming the cap (criterion 27)', async () => {
    serve({ m3: raw('m3', 3), m5: raw('m5', 5), m7: raw('m7', 7) });
    const set = buildRocketChatQuoteContextToolset(auth, 'R1');
    await body(set, 'm3');
    await body(set, 'm5');
    const out = await body(set, 'm7');
    expect(out.isError).toBe(true);
    expect(out.error).toMatch(/capped at 2 quoted messages per turn/);
  });

  it('refuses once the ten-message budget is spent, naming it (criterion 28)', async () => {
    serve({ m5: raw('m5', 5) });
    const set = buildRocketChatQuoteContextToolset(auth, 'R1');
    expect((await body(set, 'm5')).messages).toHaveLength(5);
    expect((await body(set, 'm5')).messages).toHaveLength(5);
    const out = await body(set, 'm5');
    expect(out.isError).toBe(true);
    expect(out.error).toMatch(/10-message \/ 2000-token budget/);
  });

  it('refuses an anchor outside the pinned room by name and returns nothing of it (criterion 29)', async () => {
    serve({ x1: raw('x1', 5, { rid: 'OTHER' }) });
    const out = await body(buildRocketChatQuoteContextToolset(auth, 'R1'), 'x1');
    expect(out.isError).toBe(true);
    expect(out.error).toMatch(/message x1 is not in this room/);
    expect(out.messages).toBeUndefined();
    expect(calls).not.toContain('channels.messages');
  });

  it('reports a message it cannot fetch as not found (criterion 30)', async () => {
    serve({});
    const out = await body(buildRocketChatQuoteContextToolset(auth, 'R1'), 'gone');
    expect(out.isError).toBe(true);
    expect(out.error).toMatch(/message gone was not found, or the bot cannot see it/);
  });

  it('does not expand a neighbour’s own quote (criterion 31)', async () => {
    const quoting = raw('m4', 4, { msg: '[ ](https://chat.example.com/channel/dev?msg=zz9) hm' });
    serve({ m5: raw('m5', 5) }, (side, t, count) =>
      side === 'before' ? [quoting, raw('m3', 3)] : room.filter((m) => m.ts > t).slice(0, count),
    );
    const out = await body(buildRocketChatQuoteContextToolset(auth, 'R1'), 'm5');
    expect((out.messages as Array<{ text: string }>).some((m) => m.text.includes('?msg=zz9'))).toBe(
      true,
    );
    expect(calls.filter((c) => c === 'chat.getMessage')).toHaveLength(1);
  });

  it('states the limitation when a thread anchor lies past the fetched page', async () => {
    serve({ t99: raw('t99', 59, { tmid: 'T1' }), T1: raw('T1', 11) });
    const out = await body(buildRocketChatQuoteContextToolset(auth, 'R1'), 't99');
    expect(out.limitation).toMatch(/beyond the first 50 replies/);
    expect((out.messages as unknown[]).length).toBe(1);
  });
});
