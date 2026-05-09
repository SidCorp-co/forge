import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolCallGroup, SingleToolCall } from '../chat-message/tool-call-group';
import type { ToolCallData } from '../chat-message/chat-message-types';

function makeTc(overrides: Partial<ToolCallData> = {}): ToolCallData {
  return {
    id: crypto.randomUUID(),
    name: 'Read',
    input: { file_path: '/src/file.ts' },
    result: 'file contents',
    ...overrides,
  };
}

describe('ToolCallGroup', () => {
  it('shows type name with count when all tools are same type', () => {
    const tools = [makeTc({ name: 'Read' }), makeTc({ name: 'Read' }), makeTc({ name: 'Read' })];
    render(<ToolCallGroup tools={tools} />);
    expect(screen.getByText('Read (3)')).toBeInTheDocument();
  });

  it('shows generic label when tools have mixed types', () => {
    const tools = [makeTc({ name: 'Read' }), makeTc({ name: 'Grep' })];
    render(<ToolCallGroup tools={tools} />);
    expect(screen.getByText('2 tool calls')).toBeInTheDocument();
  });

  it('shows checkmark when all tools are done', () => {
    const tools = [makeTc({ result: 'done' }), makeTc({ result: 'done' })];
    render(<ToolCallGroup tools={tools} />);
    expect(screen.getByText('✓')).toBeInTheDocument();
  });

  it('shows progress when some tools are streaming', () => {
    const tools = [
      makeTc({ result: 'done' }),
      makeTc({ result: undefined, isStreaming: true }),
    ];
    render(<ToolCallGroup tools={tools} />);
    expect(screen.getByText('(1/2)')).toBeInTheDocument();
  });

  it('expands to show individual tool calls on click', () => {
    const tools = [
      makeTc({ name: 'Read', input: { file_path: '/src/a.ts' } }),
      makeTc({ name: 'Read', input: { file_path: '/src/b.ts' } }),
    ];
    render(<ToolCallGroup tools={tools} />);

    // Collapsed by default (Read is not in EXPAND_BY_DEFAULT)
    expect(screen.queryByText(/\/src\/a\.ts/)).not.toBeInTheDocument();

    // Click to expand
    fireEvent.click(screen.getByText('Read (2)'));
    expect(screen.getByText(/\/src\/a\.ts/)).toBeInTheDocument();
    expect(screen.getByText(/\/src\/b\.ts/)).toBeInTheDocument();
  });
});

describe('SingleToolCall', () => {
  it('renders tool label', () => {
    render(<SingleToolCall tc={makeTc({ name: 'Grep', input: { pattern: 'foo', path: '/src' } })} />);
    expect(screen.getByText(/foo/)).toBeInTheDocument();
  });

  it('Edit tool is expanded by default', () => {
    render(
      <SingleToolCall
        tc={makeTc({
          name: 'Edit',
          input: { file_path: '/src/x.ts', old_string: 'old', new_string: 'new' },
        })}
      />
    );
    // Edit body should be visible (diff lines)
    expect(screen.getByText('old')).toBeInTheDocument();
    expect(screen.getByText('new')).toBeInTheDocument();
  });

  it('non-write tools are collapsed by default', () => {
    render(
      <SingleToolCall
        tc={makeTc({
          name: 'Bash',
          input: { command: 'ls -la' },
          result: 'total 0',
        })}
      />
    );
    // Result should not be visible until expanded
    expect(screen.queryByText('total 0')).not.toBeInTheDocument();
  });
});
