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

  it('stamps each message from the originating event ts (not parse time)', () => {
    const t1 = new Date('2026-05-30T10:00:00.000Z');
    const t2 = new Date('2026-05-30T10:00:05.000Z');
    const { messages } = buildSessionFromEvents([
      { kind: 'stdout', data: { line: initLine }, ts: t1 },
      { kind: 'stdout', data: { line: assistantLine }, ts: t2 },
    ]);
    expect(messages[0]?.timestamp).toBe(t1.getTime());
    expect(messages[1]?.timestamp).toBe(t2.getTime());
  });

  it('is idempotent across real-time re-derives when events carry ts', () => {
    // With per-event ts threaded through, re-derive is deterministic WITHOUT
    // freezing the clock — settled messages keep their event timestamp, so
    // entriesEqual stays true and syncTurnsWithMessages breaks on first-equal.
    const events = [
      { kind: 'stdout', data: { line: initLine }, ts: '2026-05-30T10:00:00.000Z' },
      { kind: 'stdout', data: { line: assistantLine }, ts: '2026-05-30T10:00:05.000Z' },
      { kind: 'stdout', data: { line: toolResultLine }, ts: '2026-05-30T10:00:06.000Z' },
    ];
    const a = buildSessionFromEvents(events);
    const b = buildSessionFromEvents(events);
    expect(JSON.stringify(b.messages)).toBe(JSON.stringify(a.messages));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// cm:why measured on forge-beta over 3 days to 2026-08-23: 1,051 error results, 12,899 thinking blocks and 33,671 tool results all reached the DB and were then dropped by the derive — these four fields are why the transcript read as a flat list of prose.
describe('fields the transcript used to drop', () => {
  it('keeps is_error from a tool_result and lands it on the matching toolCall', () => {
    const { messages } = buildSessionFromEvents([
      {
        kind: 'stdout',
        data: {
          line: {
            type: 'assistant',
            message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] },
          },
        },
      },
      {
        kind: 'stdout',
        data: {
          line: {
            type: 'user',
            message: {
              content: [
                { type: 'tool_result', tool_use_id: 't1', content: 'exit 1', is_error: true },
              ],
            },
          },
        },
      },
    ]);
    expect(messages[0]?.toolCalls?.[0]).toMatchObject({
      id: 't1',
      isError: true,
      output: 'exit 1',
    });
  });

  it('leaves isError unset when the tool succeeded, so a red row means a real failure', () => {
    const { messages } = buildSessionFromEvents([
      {
        kind: 'stdout',
        data: {
          line: {
            type: 'assistant',
            message: { content: [{ type: 'tool_use', id: 't1', name: 'Read' }] },
          },
        },
      },
      {
        kind: 'stdout',
        data: {
          line: {
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
            },
          },
        },
      },
    ]);
    expect(messages[0]?.toolCalls?.[0]?.isError).toBeUndefined();
  });

  it('reads total_cost_usd and the run totals off the result line', () => {
    const r = parseStreamMessages(
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 2.4137,
        duration_ms: 192_000,
        duration_api_ms: 161_000,
        num_turns: 41,
        permission_denials: [{ tool_name: 'Bash' }, { tool_name: 'Write' }],
        stop_reason: 'end_turn',
      },
      makeId(),
    );
    expect(r.messages[0]?.totals).toMatchObject({
      totalCostUsd: 2.4137,
      durationMs: 192_000,
      durationApiMs: 161_000,
      numTurns: 41,
      permissionDenials: 2,
      stopReason: 'end_turn',
    });
    expect(r.messages[0]?.content).toBe('Cost: $2.4137');
  });

  it('still reads the pre-2025 cost_usd spelling so old transcripts re-derive', () => {
    const r = parseStreamMessages({ type: 'result', cost_usd: 0.5 }, makeId());
    expect(r.messages[0]?.totals?.totalCostUsd).toBe(0.5);
  });

  it('counts thinking blocks without inventing text for them', () => {
    const r = parseStreamMessages(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: '', signature: 'sig-a' },
            { type: 'thinking', thinking: '', signature: 'sig-b' },
            { type: 'text', text: 'done' },
          ],
        },
      },
      makeId(),
    );
    expect(r.messages[0]?.thinkingCount).toBe(2);
    expect(r.messages[0]?.content).toBe('done');
    expect(r.messages[0]?.blocks?.every((b) => b.type !== 'text' || b.text === 'done')).toBe(true);
  });

  it('emits an assistant message for a turn that is thinking-only', () => {
    const r = parseStreamMessages(
      {
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: '', signature: 'sig' }] },
      },
      makeId(),
    );
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.thinkingCount).toBe(1);
  });

  it('times each tool from the gap between its own two job_events', () => {
    const { messages } = buildSessionFromEvents([
      {
        kind: 'stdout',
        ts: 1_000,
        data: {
          line: {
            type: 'assistant',
            message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] },
          },
        },
      },
      {
        kind: 'stdout',
        ts: 3_500,
        data: {
          line: {
            type: 'user',
            message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
          },
        },
      },
    ]);
    expect(messages[0]?.toolCalls?.[0]?.durationMs).toBe(2_500);
  });

  it('leaves durationMs unset when the events carry no timestamps', () => {
    const { messages } = buildSessionFromEvents([
      {
        kind: 'stdout',
        data: {
          line: {
            type: 'assistant',
            message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] },
          },
        },
      },
      {
        kind: 'stdout',
        data: {
          line: {
            type: 'user',
            message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
          },
        },
      },
    ]);
    expect(messages[0]?.toolCalls?.[0]?.durationMs).toBeUndefined();
  });
});
