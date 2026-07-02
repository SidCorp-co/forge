import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const { createLiteLLMProvider } = await import('./litellm.js');
import type { ChatStreamEvent } from './types.js';

function sseBody(events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(e));
      controller.close();
    },
  });
}

async function collect(iter: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe('litellm provider', () => {
  it('emits chunk events for delta content then done on [DONE]', async () => {
    const fetchImpl = vi.fn(
      async (..._args: unknown[]) =>
        new Response(
          sseBody([
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
            'data: [DONE]\n\n',
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );

    const provider = createLiteLLMProvider({
      baseUrl: 'http://lite/',
      apiKey: 'k',
      defaultModel: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const events = await collect(
      provider.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    );

    expect(events.filter((e) => e.type === 'chunk')).toEqual([
      { type: 'chunk', text: 'Hello' },
      { type: 'chunk', text: ' world' },
    ]);
    expect(events.at(-1)).toEqual({ type: 'done' });

    const call = fetchImpl.mock.calls[0];
    expect(call?.[0]).toBe('http://lite/v1/chat/completions');
    const init = call?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'm', stream: true });
  });

  it('emits usage event when chunk contains usage block', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          sseBody([
            'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
            'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n',
            'data: [DONE]\n\n',
          ]),
          { status: 200 },
        ),
    );

    const provider = createLiteLLMProvider({
      baseUrl: 'http://lite',
      apiKey: 'k',
      defaultModel: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const events = await collect(
      provider.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    );

    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toEqual({
      type: 'usage',
      usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
    });
  });

  it('yields error event on non-2xx response', async () => {
    const fetchImpl = vi.fn(
      async (..._args: unknown[]) => new Response('rate limited', { status: 429 }),
    );
    const provider = createLiteLLMProvider({
      baseUrl: 'http://lite',
      apiKey: 'k',
      defaultModel: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const events = await collect(
      provider.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    );

    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.type).toBe('error');
    if (ev?.type === 'error') {
      expect(ev.message).toMatch(/429/);
    }
  });

  it('yields error event when fetch throws', async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) => {
      throw new Error('network down');
    });
    const provider = createLiteLLMProvider({
      baseUrl: 'http://lite',
      apiKey: 'k',
      defaultModel: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const events = await collect(
      provider.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    );

    expect(events).toEqual([{ type: 'error', message: 'network down' }]);
  });

  it('reassembles streamed tool_call fragments and flushes on finish_reason', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          sseBody([
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"forge_issues","arguments":"{\\"act"}}]}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ion\\":\\"list\\"}"}}]}}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
            'data: [DONE]\n\n',
          ]),
          { status: 200 },
        ),
    );
    const provider = createLiteLLMProvider({
      baseUrl: 'http://lite',
      apiKey: 'k',
      defaultModel: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const events = await collect(
      provider.stream({ model: 'm', messages: [{ role: 'user', content: 'list issues' }] }),
    );

    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall).toEqual({
      type: 'tool_call',
      id: 'call_1',
      name: 'forge_issues',
      arguments: '{"action":"list"}',
    });
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('includes tools in the request body when provided', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(sseBody(['data: [DONE]\n\n']), { status: 200 }),
    );
    const provider = createLiteLLMProvider({
      baseUrl: 'http://lite',
      apiKey: 'k',
      defaultModel: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await collect(
      provider.stream({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            type: 'function',
            function: { name: 'forge_issues', description: 'd', parameters: { type: 'object' } },
          },
        ],
      }),
    );

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string) as { tools?: unknown[] };
    expect(body.tools).toHaveLength(1);
  });

  it('handles split SSE frames across reads', async () => {
    // Simulate the upstream flushing a chunk mid-event so the parser must
    // buffer until `\n\n` arrives.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          sseBody(['data: {"choices":[{"delta":{"content":"A"}', '}]}\n\n', 'data: [DONE]\n\n']),
          { status: 200 },
        ),
    );
    const provider = createLiteLLMProvider({
      baseUrl: 'http://lite',
      apiKey: 'k',
      defaultModel: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const events = await collect(
      provider.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
    );

    expect(events.filter((e) => e.type === 'chunk')).toEqual([{ type: 'chunk', text: 'A' }]);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });
});
