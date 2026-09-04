import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const { createOpenAIProvider } = await import('./openai.js');

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

describe('openai-compatible provider — response_format', () => {
  const okStream = () =>
    new Response(
      sseBody(['data: {"choices":[{"delta":{"content":"{}"}}]}\n\n', 'data: [DONE]\n\n']),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  const bodyOf = (calls: unknown[][], index: number) =>
    JSON.parse(((calls[index] as unknown[])[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;

  it('sends response_format when the request carries one', async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) => okStream());
    const provider = createOpenAIProvider({
      baseUrl: 'http://lite',
      apiKey: 'k',
      defaultModel: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await collect(
      provider.stream({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        responseFormat: { type: 'json_object' },
      }),
    );
    expect(bodyOf(fetchImpl.mock.calls, 0).response_format).toEqual({ type: 'json_object' });
  });

  it('drops response_format and retries once when the endpoint rejects the parameter', async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) =>
      fetchImpl.mock.calls.length === 1
        ? new Response('Unrecognized request argument supplied: response_format', { status: 400 })
        : okStream(),
    );
    const provider = createOpenAIProvider({
      baseUrl: 'http://lite',
      apiKey: 'k',
      defaultModel: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryDelaysMs: [0, 0],
    });
    const events = await collect(
      provider.stream({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        responseFormat: { type: 'json_schema', json_schema: { name: 'x', schema: {} } },
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchImpl.mock.calls, 0)).toHaveProperty('response_format');
    expect(bodyOf(fetchImpl.mock.calls, 1)).not.toHaveProperty('response_format');
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('a 400 that rejects the content, not the parameter, is not retried', async () => {
    const fetchImpl = vi.fn(
      async (..._args: unknown[]) => new Response('messages[0] is invalid', { status: 400 }),
    );
    const provider = createOpenAIProvider({
      baseUrl: 'http://lite',
      apiKey: 'k',
      defaultModel: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryDelaysMs: [0, 0],
    });
    const events = await collect(
      provider.stream({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        responseFormat: { type: 'json_object' },
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.type).toBe('error');
  });
});
