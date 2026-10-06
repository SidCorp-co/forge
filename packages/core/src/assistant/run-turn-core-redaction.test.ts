import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import type { ChatProvider, ChatStreamEvent } from './providers/types.js';
import { runTurnEvents } from './run-turn-core.js';
import { thrownMessage } from './tools/mcp-adapter.js';

const SECRET = 'c3ludGhldGljLWFzc2lzdGFudC12YWx1ZQ';

function failedQuery(): DrizzleQueryError {
  return new DrizzleQueryError(
    'select * from "integrations" where "api_key_hash" = $1',
    [SECRET],
    Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
  );
}

describe("the assistant's error text", () => {
  it("streams a turn's failure with none of a failed query's bound params", async () => {
    const provider: ChatProvider = {
      id: 'stub',
      defaultModel: 'stub',
      // biome-ignore lint/correctness/useYield: a provider whose first read fails
      async *stream(): AsyncIterable<ChatStreamEvent> {
        throw failedQuery();
      },
    };
    const events: ChatStreamEvent[] = [];
    const turn = runTurnEvents({ provider, model: 'stub', messages: [] });
    for (let next = await turn.next(); !next.done; next = await turn.next())
      events.push(next.value);

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect(JSON.stringify(error)).toContain('select * from \\"integrations\\"');
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it("feeds back a toolset's own rejection with none of a failed query's bound params", async () => {
    let round = 0;
    const provider: ChatProvider = {
      id: 'stub',
      defaultModel: 'stub',
      async *stream(): AsyncIterable<ChatStreamEvent> {
        round++;
        if (round === 1) yield { type: 'tool_call', id: 't1', name: 'lookup', arguments: '{}' };
        else yield { type: 'chunk', text: 'done' };
      },
    };
    const tools = {
      tools: [
        {
          type: 'function' as const,
          function: { name: 'lookup', description: '', parameters: {} },
        },
      ],
      execute: async () => {
        throw failedQuery();
      },
    };
    const events: ChatStreamEvent[] = [];
    const turn = runTurnEvents({ provider, model: 'stub', messages: [], tools: tools as never });
    for (let next = await turn.next(); !next.done; next = await turn.next())
      events.push(next.value);
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it("hands the model a tool's failure with none of its bound params, wrapped or not", () => {
    expect(thrownMessage(failedQuery())).not.toContain(SECRET);
    const wrapped = new Error('tool failed', { cause: failedQuery() });
    expect(thrownMessage(wrapped)).toContain('select * from "integrations"');
    expect(thrownMessage(wrapped)).not.toContain(SECRET);
  });
});
