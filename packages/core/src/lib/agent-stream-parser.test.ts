import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentMessage,
  buildSessionFromEvents,
  createIdFactory,
  mergeMessages,
  parseStreamMessages,
} from './agent-stream-parser.js';

const makeId = () => createIdFactory();

describe('parseStreamMessages', () => {
  it('extracts the claude session id from a system/init line', () => {
    const r = parseStreamMessages(
      { type: 'system', subtype: 'init', session_id: 'claude-abc' },
      makeId(),
    );
    expect(r.sessionId).toBe('claude-abc');
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ type: 'system', content: 'Session started' });
  });

  it('parses assistant text into an assistant message', () => {
    const r = parseStreamMessages(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }], model: 'opus' } },
      makeId(),
    );
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ type: 'assistant', content: 'hello', model: 'opus' });
    expect(r.messages[0]?.blocks).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('parses a tool_use block into a toolCall + tool block', () => {
    const r = parseStreamMessages(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'a.ts' } }],
        },
      },
      makeId(),
    );
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.toolCalls).toEqual([
      { id: 'tool-1', name: 'Read', input: { file: 'a.ts' } },
    ]);
    expect(r.messages[0]?.blocks).toEqual([
      { type: 'tool', toolCall: { id: 'tool-1', name: 'Read', input: { file: 'a.ts' } } },
    ]);
  });

  it('parses a TodoWrite tool_use into a todos block (not a tool call)', () => {
    const r = parseStreamMessages(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'TodoWrite',
              input: { todos: [{ content: 'do it', status: 'in_progress' }] },
            },
          ],
        },
      },
      makeId(),
    );
    expect(r.messages[0]?.toolCalls).toBeUndefined();
    expect(r.messages[0]?.blocks).toEqual([
      {
        type: 'todos',
        todos: [{ content: 'do it', status: 'in_progress', activeForm: undefined }],
      },
    ]);
  });

  it('parses a user tool_result line into a tool_result message keyed by tool id', () => {
    const r = parseStreamMessages(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file body' }],
        },
      },
      makeId(),
    );
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({
      type: 'tool_result',
      toolName: 'tool-1',
      toolOutput: 'file body',
    });
  });

  it('renders a result line with cost as a system message', () => {
    const r = parseStreamMessages({ type: 'result', cost_usd: 0.1234 }, makeId());
    expect(r.messages[0]).toMatchObject({ type: 'system', content: 'Cost: $0.1234' });
  });

  it('returns nothing for unknown / malformed lines', () => {
    expect(parseStreamMessages(null, makeId()).messages).toHaveLength(0);
    expect(parseStreamMessages({ noType: true }, makeId()).messages).toHaveLength(0);
    expect(parseStreamMessages('a raw string', makeId()).messages).toHaveLength(0);
  });
});

describe('mergeMessages', () => {
  it('attaches a tool_result to the matching toolCall on the preceding assistant message', () => {
    const id = makeId();
    const messages: AgentMessage[] = [];
    mergeMessages(
      messages,
      parseStreamMessages(
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read' }] },
        },
        id,
      ).messages,
    );
    mergeMessages(
      messages,
      parseStreamMessages(
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'out' }] },
        },
        id,
      ).messages,
    );
    // The tool_result wires into the assistant's toolCall output rather than
    // appending a standalone message.
    expect(messages).toHaveLength(1);
    expect(messages[0]?.toolCalls?.[0]).toMatchObject({ id: 'tool-1', output: 'out' });
    expect(messages[0]?.blocks?.[0]).toMatchObject({ toolCall: { id: 'tool-1', output: 'out' } });
  });

  it('merges streamed assistant continuations into the last assistant message', () => {
    const id = makeId();
    const messages: AgentMessage[] = [];
    mergeMessages(
      messages,
      parseStreamMessages(
        { type: 'assistant', message: { content: [{ type: 'text', text: 'A' }] } },
        id,
      ).messages,
    );
    mergeMessages(
      messages,
      parseStreamMessages(
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash' }] } },
        id,
      ).messages,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.toolCalls).toEqual([{ id: 't2', name: 'Bash', input: {} }]);
  });
});

describe('buildSessionFromEvents', () => {
  const initLine = { type: 'system', subtype: 'init', session_id: 'claude-xyz' };
  const assistantLine = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'working' },
        { type: 'tool_use', id: 'tool-1', name: 'Read' },
      ],
    },
  };
  const toolResultLine = {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] },
  };

  it('derives the full transcript + claudeSessionId from ordered stdout events', () => {
    const { messages, claudeSessionId } = buildSessionFromEvents([
      { kind: 'stdout', data: { line: initLine } },
      { kind: 'stdout', data: { line: assistantLine } },
      { kind: 'stdout', data: { line: toolResultLine } },
      { kind: 'stdout', data: { line: { type: 'result', cost_usd: 0.01 } } },
    ]);
    expect(claudeSessionId).toBe('claude-xyz');
    // system(init) + assistant(with wired tool output) + system(result)
    expect(messages.map((m) => m.type)).toEqual(['system', 'assistant', 'system']);
    expect(messages[1]?.toolCalls?.[0]).toMatchObject({ id: 'tool-1', output: 'done' });
  });

  it('falls back to a progress event for claudeSessionId when no init line carries it', () => {
    const { claudeSessionId } = buildSessionFromEvents([
      { kind: 'progress', data: { claudeSessionId: 'from-progress' } },
      { kind: 'stdout', data: { line: assistantLine } },
    ]);
    expect(claudeSessionId).toBe('from-progress');
  });

  it('ignores non-stream events and stdout rows without a line', () => {
    const { messages, claudeSessionId } = buildSessionFromEvents([
      { kind: 'tool_call', data: { name: 'Read' } },
      { kind: 'stdout', data: {} },
      { kind: 'progress', data: { usage: { input: 1 } } },
    ]);
    expect(messages).toHaveLength(0);
    expect(claudeSessionId).toBeNull();
  });

  it('is idempotent — re-deriving the same events yields identical output', () => {
    // Freeze time so the only thing that could differ between derives (the
    // per-line Date.now() timestamp) is held constant — proving id/shape
    // stability, which is what keeps syncTurnsWithMessages from churning.
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const events = [
        { kind: 'stdout', data: { line: initLine } },
        { kind: 'stdout', data: { line: assistantLine } },
        { kind: 'stdout', data: { line: toolResultLine } },
      ];
      const a = buildSessionFromEvents(events);
      const b = buildSessionFromEvents(events);
      expect(JSON.stringify(b.messages)).toBe(JSON.stringify(a.messages));
    } finally {
      now.mockRestore();
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
