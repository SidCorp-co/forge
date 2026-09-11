import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './providers/types.js';
import { applyTurnContext, renderTurnContext } from './turn-context.js';

const sys: ChatMessage = { role: 'system', content: 'SYS' };

describe('renderTurnContext', () => {
  it('renders the conversation seed and the page context as labelled sections', () => {
    const out = renderTurnContext({
      conversationContext: '[an]: deploy is failing',
      pageContext: { url: '/dash' },
    });
    expect(out).toContain('Conversation context');
    expect(out).toContain('[an]: deploy is failing');
    expect(out).toContain('Page context:\n{\n  "url": "/dash"\n}');
  });

  it('is null when both are blank or empty', () => {
    expect(renderTurnContext({ conversationContext: '   ', pageContext: {} })).toBeNull();
    expect(renderTurnContext({})).toBeNull();
  });
});

describe('applyTurnContext', () => {
  it('prefixes the NEWEST user message and leaves the system prompt byte-identical', () => {
    const messages: ChatMessage[] = [
      sys,
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'now' },
    ];
    const out = applyTurnContext(messages, { conversationContext: '[an]: hi' });
    expect(out[0]).toBe(sys);
    expect(out[1]?.content).toBe('earlier');
    expect(out[3]?.content).toBe(
      'Conversation context — the discussion that led to this message (if it references older matter, use the available history tools before concluding):\n[an]: hi\n\n---\n\nnow',
    );
    expect(messages[3]?.content).toBe('now');
  });

  it('puts the context first as a text part when the newest message carries images', () => {
    const messages: ChatMessage[] = [
      sys,
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        ],
      },
    ];
    const out = applyTurnContext(messages, { pageContext: { issue: 'ISS-1' } });
    const parts = out[1]?.content as Array<{ type: string; text?: string }>;
    expect(parts.map((p) => p.type)).toEqual(['text', 'text', 'image_url']);
    expect(parts[0]?.text).toContain('Page context');
    expect(parts[1]?.text).toBe('see this');
  });

  it('is the identity when there is nothing to add', () => {
    const messages: ChatMessage[] = [sys, { role: 'user', content: 'now' }];
    expect(applyTurnContext(messages, {})).toEqual(messages);
    expect(applyTurnContext(messages, { conversationContext: ' ' })).toEqual(messages);
  });
});
