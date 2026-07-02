import { describe, expect, it } from 'vitest';
import type { ChatProvider, ChatStreamEvent } from './providers/types.js';
import { type TurnCoreResult, runTurnEvents } from './run-turn-core.js';
import type { ChatToolset } from './tools/mcp-adapter.js';

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
        return '{"ok":true}';
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
    expect(result.toolCalls).toEqual([{ name: 'get', arguments: '{"x":1}' }]);
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
});
