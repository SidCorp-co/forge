import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatMessage } from '../chat-message/chat-message';
import type { ChatMessageData, ToolCallData } from '../chat-message/chat-message-types';

// Mock Markdown to simplify output
vi.mock('@/components/ui/markdown', () => ({
  Markdown: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

function makeTool(name: string, id?: string): ToolCallData {
  return { id: id ?? crypto.randomUUID(), name, input: {}, result: 'ok' };
}

function makeAssistantMsg(overrides: Partial<ChatMessageData> = {}): ChatMessageData {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('ChatMessage tool call grouping', () => {
  it('groups consecutive same-type tool_use blocks', () => {
    const msg = makeAssistantMsg({
      contentBlocks: [
        { type: 'tool_use', tool: makeTool('Read', 'r1') },
        { type: 'tool_use', tool: makeTool('Read', 'r2') },
        { type: 'tool_use', tool: makeTool('Read', 'r3') },
      ],
    });
    render(<ChatMessage message={msg} />);
    // Should show "Read (3)" group label
    expect(screen.getByText('Read (3)')).toBeInTheDocument();
  });

  it('splits groups when tool type changes', () => {
    const msg = makeAssistantMsg({
      contentBlocks: [
        { type: 'tool_use', tool: makeTool('Read', 'r1') },
        { type: 'tool_use', tool: makeTool('Read', 'r2') },
        { type: 'tool_use', tool: makeTool('Grep', 'g1') },
        { type: 'tool_use', tool: makeTool('Grep', 'g2') },
      ],
    });
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('Read (2)')).toBeInTheDocument();
    expect(screen.getByText('Grep (2)')).toBeInTheDocument();
  });

  it('text blocks break tool grouping', () => {
    const msg = makeAssistantMsg({
      contentBlocks: [
        { type: 'tool_use', tool: makeTool('Read', 'r1') },
        { type: 'tool_use', tool: makeTool('Read', 'r2') },
        { type: 'text', text: 'Now updating the file' },
        { type: 'tool_use', tool: makeTool('Read', 'r3') },
      ],
    });
    render(<ChatMessage message={msg} />);
    // First group of 2 Reads
    expect(screen.getByText('Read (2)')).toBeInTheDocument();
    // Text block
    expect(screen.getByText('Now updating the file')).toBeInTheDocument();
    // Single Read renders as SingleToolCall (no group wrapper)
    // There should NOT be a second "Read (1)" — single tools render inline
  });

  it('single tool_use renders without group wrapper', () => {
    const msg = makeAssistantMsg({
      contentBlocks: [
        { type: 'tool_use', tool: makeTool('Bash', 'b1') },
      ],
    });
    render(<ChatMessage message={msg} />);
    // Should NOT show "Bash (1)" — single tools render as SingleToolCall
    expect(screen.queryByText('Bash (1)')).not.toBeInTheDocument();
  });

  it('renders user message with prompt prefix', () => {
    const msg: ChatMessageData = {
      id: '1',
      role: 'user',
      content: 'Fix the bug',
      timestamp: Date.now(),
    };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('❯')).toBeInTheDocument();
    expect(screen.getByText('Fix the bug')).toBeInTheDocument();
  });

  it('renders system message', () => {
    const msg: ChatMessageData = {
      id: '1',
      role: 'system',
      content: 'Session started',
      timestamp: Date.now(),
    };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('Session started')).toBeInTheDocument();
  });
});
