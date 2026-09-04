import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '../mcp/tool-result.js';
import type { ChatProvider, ChatStreamEvent } from './providers/types.js';
import { MAX_TOOL_ITERATIONS, runTurnEvents, type TurnCoreResult } from './run-turn-core.js';
import type { ChatToolset } from './tools/mcp-adapter.js';

const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });

async function drain(gen: AsyncGenerator<ChatStreamEvent, TurnCoreResult>) {
  const events: ChatStreamEvent[] = [];
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    step = await gen.next();
  }
  return { events, result: step.value };
}

function provider(rounds: ChatStreamEvent[][]): ChatProvider {
  let call = 0;
  return {
    id: 'mock',
    defaultModel: 'm',
    async *stream(): AsyncIterable<ChatStreamEvent> {
      const round = rounds[Math.min(call, rounds.length - 1)] ?? [{ type: 'done' }];
      call++;
      for (const e of round) yield e;
    },
  };
}

describe('runTurnEvents', () => {
  it('returns the final text with no tools (single round)', async () => {
    const { events, result } = await drain(
      runTurnEvents({
        provider: provider([[{ type: 'chunk', text: 'hi' }, { type: 'done' }]]),
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(events.map((e) => e.type)).toEqual(['chunk', 'done']);
    expect(result.finalText).toBe('hi');
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toEqual([]);
    expect(result.terminal).toBe('done');
  });

  it('runs a tool then re-invokes for the final answer', async () => {
    let executed: { name: string; args: string } | null = null;
    const tools: ChatToolset = {
      tools: [{ type: 'function', function: { name: 'get', parameters: {} } }],
      execute: async (name, args) => {
        executed = { name, args };
        return ok('{"ok":true}');
      },
    };
    const { events, result } = await drain(
      runTurnEvents({
        provider: provider([
          [{ type: 'tool_call', id: 'c1', name: 'get', arguments: '{"x":1}' }, { type: 'done' }],
          [{ type: 'chunk', text: 'done!' }, { type: 'done' }],
        ]),
        model: 'm',
        messages: [{ role: 'user', content: 'go' }],
        tools,
      }),
    );
    expect(executed).toEqual({ name: 'get', args: '{"x":1}' });
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_result', 'chunk', 'done']);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(result.finalText).toBe('done!');
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toEqual([
      {
        name: 'get',
        arguments: '{"x":1}',
        round: 1,
        isError: false,
        durationMs: expect.any(Number),
        resultPreview: '{"ok":true}',
      },
    ]);
  });

  it('surfaces a provider error as terminal error, never throws', async () => {
    const { events, result } = await drain(
      runTurnEvents({
        provider: provider([[{ type: 'error', message: 'boom' }]]),
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
      }),
    );
    expect(events.at(-1)).toEqual({ type: 'error', message: 'boom' });
    expect(result.terminal).toBe('error');
    expect(result.errorMessage).toBe('boom');
  });

  it('spends its last round on prose instead of discarding a tool-hungry turn', async () => {
    const offered: boolean[] = [];
    const insatiable: ChatProvider = {
      id: 'mock',
      defaultModel: 'm',
      async *stream(req): AsyncIterable<ChatStreamEvent> {
        const hasTools = !!req.tools && req.tools.length > 0;
        offered.push(hasTools);
        if (hasTools) {
          yield { type: 'tool_call', id: `c${offered.length}`, name: 'get', arguments: '{}' };
        } else {
          yield { type: 'chunk', text: 'here is what I found' };
        }
        yield { type: 'done' };
      },
    };
    const tools: ChatToolset = {
      tools: [{ type: 'function', function: { name: 'get', parameters: {} } }],
      execute: async () => ok('{"ok":true}'),
    };

    const { events, result } = await drain(
      runTurnEvents({
        provider: insatiable,
        model: 'm',
        messages: [{ role: 'user', content: 'investigate' }],
        tools,
      }),
    );

    expect(result.finalText).toBe('here is what I found');
    expect(result.terminal).toBe('done');
    expect(result.iterations).toBe(MAX_TOOL_ITERATIONS);
    expect(result.toolCalls).toHaveLength(MAX_TOOL_ITERATIONS - 1);
    expect(offered).toEqual([...Array<boolean>(MAX_TOOL_ITERATIONS - 1).fill(true), false]);
    const calls = events.filter((e) => e.type === 'tool_call');
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results).toHaveLength(calls.length);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('never puts an unanswerable tool_call on the wire when the last round ignores having no tools', async () => {
    const defiant: ChatProvider = {
      id: 'mock',
      defaultModel: 'm',
      async *stream(req): AsyncIterable<ChatStreamEvent> {
        const hasTools = !!req.tools && req.tools.length > 0;
        yield {
          type: 'tool_call',
          id: hasTools ? 'real' : 'invented',
          name: 'escalate',
          arguments: '{}',
        };
        if (!hasTools) yield { type: 'chunk', text: 'partial answer' };
        yield { type: 'done' };
      },
    };
    const tools: ChatToolset = {
      tools: [{ type: 'function', function: { name: 'escalate', parameters: {} } }],
      execute: async () => ok('{"ok":true}'),
    };

    const { events, result } = await drain(
      runTurnEvents({
        provider: defiant,
        model: 'm',
        messages: [{ role: 'user', content: 'investigate' }],
        tools,
      }),
    );

    const calls = events.filter((e) => e.type === 'tool_call');
    const results = events.filter((e) => e.type === 'tool_result');
    expect(calls).toHaveLength(results.length);
    expect(calls.some((e) => e.type === 'tool_call' && e.id === 'invented')).toBe(false);
    expect(result.toolCalls).toHaveLength(MAX_TOOL_ITERATIONS - 1);
    expect(result.finalText).toBe('partial answer');
    expect(result.terminal).toBe('done');
    expect(events.at(-1)).toEqual({ type: 'done' });
  });
});

describe('runTurnEvents — tool-call records', () => {
  it('records an MCP isError result as an error and still feeds its text back to the model', async () => {
    const seen: unknown[][] = [];
    const recording: ChatProvider = {
      id: 'mock',
      defaultModel: 'm',
      async *stream(req): AsyncIterable<ChatStreamEvent> {
        seen.push(req.messages);
        if (seen.length === 1) {
          yield { type: 'tool_call', id: 'c1', name: 'get', arguments: '{}' };
        } else {
          yield { type: 'chunk', text: 'sorry' };
        }
        yield { type: 'done' };
      },
    };
    const tools: ChatToolset = {
      tools: [{ type: 'function', function: { name: 'get', parameters: {} } }],
      execute: async () => ({
        content: [{ type: 'text', text: '{"error":"not permitted"}' }],
        isError: true,
      }),
    };
    const { result } = await drain(
      runTurnEvents({
        provider: recording,
        model: 'm',
        messages: [{ role: 'user', content: 'go' }],
        tools,
      }),
    );
    expect(result.terminal).toBe('done');
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: 'get',
        round: 1,
        isError: true,
        resultPreview: '{"error":"not permitted"}',
      }),
    ]);
    expect(seen[1]).toContainEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: '{"error":"not permitted"}',
    });
  });

  it('keeps only a preview of a long result in the record', async () => {
    const tools: ChatToolset = {
      tools: [{ type: 'function', function: { name: 'get', parameters: {} } }],
      execute: async () => ok('y'.repeat(2_000)),
    };
    const { result } = await drain(
      runTurnEvents({
        provider: provider([
          [{ type: 'tool_call', id: 'c1', name: 'get', arguments: '{}' }, { type: 'done' }],
          [{ type: 'chunk', text: 'ok' }, { type: 'done' }],
        ]),
        model: 'm',
        messages: [{ role: 'user', content: 'go' }],
        tools,
      }),
    );
    expect(result.toolCalls[0]?.resultPreview).toHaveLength(500);
  });
});
