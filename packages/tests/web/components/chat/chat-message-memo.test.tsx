import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { ChatMessage } from '@/components/chat/chat-message/chat-message';
import type { ChatMessageData } from '@/components/chat/chat-message/chat-message-types';

const markdownRenderSpy = vi.fn();
vi.mock('@/components/ui/markdown', () => ({
  Markdown: ({ children }: { children: string }) => {
    markdownRenderSpy(children);
    return createElement('div', { 'data-testid': 'markdown' }, children);
  },
}));

function makeAssistantMsg(overrides: Partial<ChatMessageData> = {}): ChatMessageData {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('ChatMessage memoization', () => {
  it('skips re-render when the same message reference is passed', () => {
    const msg = makeAssistantMsg({
      contentBlocks: [{ type: 'text', text: 'hello world' }],
    });

    markdownRenderSpy.mockClear();
    const { rerender } = render(createElement(ChatMessage, { message: msg }));
    const initialCalls = markdownRenderSpy.mock.calls.length;
    expect(initialCalls).toBeGreaterThan(0);

    rerender(createElement(ChatMessage, { message: msg }));
    expect(markdownRenderSpy.mock.calls.length).toBe(initialCalls);
  });

  it('re-renders when a new message reference with different content is passed', () => {
    const msgA = makeAssistantMsg({
      contentBlocks: [{ type: 'text', text: 'first' }],
    });
    const msgB: ChatMessageData = {
      ...msgA,
      contentBlocks: [{ type: 'text', text: 'second' }],
    };

    markdownRenderSpy.mockClear();
    const { rerender } = render(createElement(ChatMessage, { message: msgA }));
    const callsAfterFirst = markdownRenderSpy.mock.calls.length;

    rerender(createElement(ChatMessage, { message: msgB }));
    expect(markdownRenderSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(screen.getByText('second')).toBeInTheDocument();
  });
});
