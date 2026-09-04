import { describe, expect, it } from 'vitest';
import { applyContextBudget, estimateMessageTokens, IMAGE_PART_TOKENS } from './context-budget.js';
import type { ChatMessage } from './providers/types.js';

const sys: ChatMessage = { role: 'system', content: 'S'.repeat(40) };
const user = (text: string): ChatMessage => ({ role: 'user', content: text });
const assistant = (text: string): ChatMessage => ({ role: 'assistant', content: text });
const toolCall = (id: string): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name: 'get', arguments: '{}' } }],
});
const toolReply = (id: string, text: string): ChatMessage => ({
  role: 'tool',
  tool_call_id: id,
  content: text,
});
const tokens = (ms: readonly ChatMessage[]) => ms.reduce((n, m) => n + estimateMessageTokens(m), 0);

describe('applyContextBudget', () => {
  it('pins the system message and the newest user turn and drops the oldest history first', () => {
    const history = [user('oldest'.repeat(20)), assistant('a1'.repeat(20)), user('u2'.repeat(20))];
    const newest = user('now');
    const all = [sys, ...history, newest];
    const budget = tokens([sys, newest]) + tokens([history[2] as ChatMessage]) + 4;
    const out = applyContextBudget(all, { budgetTokens: budget, reservedTokens: 0 });
    expect(out.messages[0]).toBe(sys);
    expect(out.messages.at(-1)?.content).toMatch(/now$/);
    expect(out.elided).toEqual({ historyMessages: 2, truncatedToolResults: 0, overBudget: false });
    expect(out.messages.some((m) => String(m.content).startsWith('oldest'))).toBe(false);
    expect(out.messages.map((m) => m.role)).toEqual(['system', 'user', 'user']);
  });

  it('tells the model how many earlier messages it can no longer see, once, on the first kept user message', () => {
    const all = [sys, user('a'.repeat(400)), assistant('b'.repeat(400)), user('c'), user('now')];
    const out = applyContextBudget(all, {
      budgetTokens: tokens([sys, all[3] as ChatMessage, all[4] as ChatMessage]) + 8,
      reservedTokens: 0,
    });
    expect(out.messages[1]?.content).toBe('[2 earlier messages omitted for length]\n\nc');
    expect(out.messages[2]?.content).toBe('now');
    const again = applyContextBudget(out.messages, {
      budgetTokens: tokens([sys, all[4] as ChatMessage]) + 4,
      reservedTokens: 0,
    });
    expect(again.messages[1]?.content).toBe('[3 earlier messages omitted for length]\n\nnow');
    expect(again.messages).toHaveLength(2);
  });

  it('never splits an assistant tool_calls message from its tool replies', () => {
    const pair = [toolCall('c1'), toolReply('c1', 'r'.repeat(200))];
    const all = [sys, user('q'), ...pair, assistant('ans'), user('now')];
    const budget = tokens(all) - tokens([pair[1] as ChatMessage]) + 2;
    const out = applyContextBudget(all, { budgetTokens: budget, reservedTokens: 0 });
    const ids = new Set(out.messages.flatMap((m) => m.tool_calls?.map((t) => t.id) ?? []));
    for (const m of out.messages) {
      if (m.role === 'tool') expect(ids.has(m.tool_call_id ?? '')).toBe(true);
    }
    expect(out.messages.some((m) => m.tool_calls)).toBe(false);
    expect(out.elided.historyMessages).toBe(3);
  });

  it('truncates the OLDEST intra-turn tool result in place and leaves the newer one intact', () => {
    const newest = user('go');
    const intra = [
      toolCall('c1'),
      toolReply('c1', 'x'.repeat(4_000)),
      toolCall('c2'),
      toolReply('c2', 'y'.repeat(4_000)),
    ];
    const all = [sys, newest, ...intra];
    const out = applyContextBudget(all, { budgetTokens: 1_500, reservedTokens: 0 });
    const c1 = out.messages.find((m) => m.tool_call_id === 'c1');
    const c2 = out.messages.find((m) => m.tool_call_id === 'c2');
    expect(c1?.content).toMatch(/^\[tool result elided: 4000 chars removed/);
    expect(c2?.content).toBe('y'.repeat(4_000));
    expect(out.elided).toEqual({ historyMessages: 0, truncatedToolResults: 1, overBudget: false });
    expect(out.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
    ]);
    expect(intra[1]?.content).toBe('x'.repeat(4_000));
  });

  it('bills an image part flat instead of by its data-URI length', () => {
    const withImage: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'see this' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(2_000_000)}` } },
      ],
    };
    expect(estimateMessageTokens(withImage)).toBeLessThan(IMAGE_PART_TOKENS + 20);
    const out = applyContextBudget([sys, user('earlier'), withImage], {
      budgetTokens: 5_000,
      reservedTokens: 0,
    });
    expect(out.elided.historyMessages).toBe(0);
  });

  it('reports overBudget and drops nothing when the pinned messages alone do not fit', () => {
    const all = [sys, user('h1'), user('n'.repeat(4_000))];
    const out = applyContextBudget(all, { budgetTokens: 500, reservedTokens: 0 });
    expect(out.elided.overBudget).toBe(true);
    expect(out.elided.historyMessages).toBe(0);
    expect(out.messages).toEqual(all);
  });

  it('counts the reserved tool-schema tokens against the budget', () => {
    const all = [sys, user('h'.repeat(400)), user('now')];
    const fits = applyContextBudget(all, { budgetTokens: tokens(all) + 1, reservedTokens: 0 });
    expect(fits.elided.historyMessages).toBe(0);
    const squeezed = applyContextBudget(all, { budgetTokens: tokens(all) + 1, reservedTokens: 50 });
    expect(squeezed.elided.historyMessages).toBe(1);
  });

  it('is the identity on a request with no user message', () => {
    const all = [sys, assistant('only')];
    const out = applyContextBudget(all, { budgetTokens: 1, reservedTokens: 0 });
    expect(out.messages).toEqual(all);
    expect(out.elided.overBudget).toBe(false);
  });
});
