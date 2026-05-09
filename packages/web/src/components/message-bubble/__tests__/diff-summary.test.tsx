import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DiffSummary } from '../chat-message/diff-summary';
import type { ChatMessageData } from '../chat-message/chat-message-types';

function makeMsg(overrides: Partial<ChatMessageData> = {}): ChatMessageData {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('DiffSummary', () => {
  it('returns null when there are no Edit/Write tool calls', () => {
    const messages: ChatMessageData[] = [
      makeMsg({ role: 'user', content: 'hello' }),
      makeMsg({ content: 'hi there' }),
    ];
    const { container } = render(<DiffSummary messages={messages} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows file count and line counts for Edit tool calls', () => {
    const messages: ChatMessageData[] = [
      makeMsg({
        toolCalls: [
          {
            id: '1',
            name: 'Edit',
            input: {
              file_path: '/src/app.ts',
              old_string: 'const a = 1;\nconst b = 2;',
              new_string: 'const a = 10;\nconst b = 20;\nconst c = 30;',
            },
          },
        ],
      }),
    ];
    render(<DiffSummary messages={messages} />);
    expect(screen.getByText('1 file changed')).toBeInTheDocument();
    // +3 and -2 appear in both summary header and file card
    expect(screen.getAllByText('+3')).toHaveLength(2);
    expect(screen.getAllByText('-2')).toHaveLength(2);
  });

  it('shows NEW badge for Write tool calls', () => {
    const messages: ChatMessageData[] = [
      makeMsg({
        toolCalls: [
          {
            id: '1',
            name: 'Write',
            input: { file_path: '/src/new-file.ts', content: 'line1\nline2' },
          },
        ],
      }),
    ];
    render(<DiffSummary messages={messages} />);
    expect(screen.getByText('1 file changed')).toBeInTheDocument();
    expect(screen.getByText('NEW')).toBeInTheDocument();
    expect(screen.getByText('/src/new-file.ts')).toBeInTheDocument();
  });

  it('groups multiple edits to the same file', () => {
    const messages: ChatMessageData[] = [
      makeMsg({
        toolCalls: [
          {
            id: '1',
            name: 'Edit',
            input: { file_path: '/src/app.ts', old_string: 'a', new_string: 'b' },
          },
          {
            id: '2',
            name: 'Edit',
            input: { file_path: '/src/app.ts', old_string: 'c', new_string: 'd' },
          },
        ],
      }),
    ];
    render(<DiffSummary messages={messages} />);
    expect(screen.getByText('1 file changed')).toBeInTheDocument();
  });

  it('counts multiple files correctly', () => {
    const messages: ChatMessageData[] = [
      makeMsg({
        toolCalls: [
          {
            id: '1',
            name: 'Edit',
            input: { file_path: '/src/a.ts', old_string: 'x', new_string: 'y' },
          },
          {
            id: '2',
            name: 'Write',
            input: { file_path: '/src/b.ts', content: 'new file' },
          },
        ],
      }),
    ];
    render(<DiffSummary messages={messages} />);
    expect(screen.getByText('2 files changed')).toBeInTheDocument();
  });

  it('extracts diffs from contentBlocks', () => {
    const messages: ChatMessageData[] = [
      makeMsg({
        contentBlocks: [
          {
            type: 'tool_use',
            tool: {
              id: '1',
              name: 'Edit',
              input: { file_path: '/src/x.ts', old_string: 'old', new_string: 'new' },
            },
          },
        ],
      }),
    ];
    render(<DiffSummary messages={messages} />);
    expect(screen.getByText('1 file changed')).toBeInTheDocument();
    expect(screen.getByText('/src/x.ts')).toBeInTheDocument();
  });

  it('expands file diff card on click to show diff lines', () => {
    const messages: ChatMessageData[] = [
      makeMsg({
        toolCalls: [
          {
            id: '1',
            name: 'Edit',
            input: { file_path: '/src/app.ts', old_string: 'removed line', new_string: 'added line' },
          },
        ],
      }),
    ];
    render(<DiffSummary messages={messages} />);

    // File card is collapsed by default — diff lines not visible
    expect(screen.queryByText('removed line')).not.toBeInTheDocument();

    // Click file card to expand
    fireEvent.click(screen.getByText('/src/app.ts'));
    expect(screen.getByText('removed line')).toBeInTheDocument();
    expect(screen.getByText('added line')).toBeInTheDocument();
  });

  it('ignores user messages', () => {
    const messages: ChatMessageData[] = [
      makeMsg({
        role: 'user',
        content: 'edit the file',
        toolCalls: [
          {
            id: '1',
            name: 'Edit',
            input: { file_path: '/src/app.ts', old_string: 'a', new_string: 'b' },
          },
        ],
      }),
    ];
    const { container } = render(<DiffSummary messages={messages} />);
    expect(container.innerHTML).toBe('');
  });
});
