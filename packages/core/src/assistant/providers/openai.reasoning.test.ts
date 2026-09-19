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

describe('openai-compatible provider — reasoning', () => {
  it('turns delta.reasoning_content into reasoning events, in order with the prose', async () => {
    const fetchImpl = vi.fn(
      async (..._args: unknown[]) =>
        new Response(
          sseBody([
            'data: {"choices":[{"delta":{"reasoning_content":"let me "}}]}\n\n',
            'data: {"choices":[{"delta":{"reasoning_content":"check"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"Two left."}}]}\n\n',
            'data: [DONE]\n\n',
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const provider = createOpenAIProvider({
      baseUrl: 'https://x.test/v1',
      apiKey: 'k',
      defaultModel: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryDelaysMs: [0],
    });
    const events = await collect(
      provider.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(events).toEqual([
      { type: 'reasoning', text: 'let me ' },
      { type: 'reasoning', text: 'check' },
      { type: 'chunk', text: 'Two left.' },
      { type: 'done' },
    ]);
  });

  it('yields no reasoning event for a stream that carries none', async () => {
    const fetchImpl = vi.fn(
      async (..._args: unknown[]) =>
        new Response(
          sseBody([
            'data: {"choices":[{"delta":{"content":"Two left."}}]}\n\n',
            'data: [DONE]\n\n',
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const provider = createOpenAIProvider({
      baseUrl: 'https://x.test/v1',
      apiKey: 'k',
      defaultModel: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryDelaysMs: [0],
    });
    const events = await collect(
      provider.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(events.filter((e) => e.type === 'reasoning')).toEqual([]);
  });
});
