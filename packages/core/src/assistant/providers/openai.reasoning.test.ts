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

// cm:why its own file rather than a describe in `openai.test.ts`: that file is at its frozen size
// budget, and the budget's answer to a legitimate addition is a split — `openai.response-format.test.ts`
// is the same split for the same reason.
describe('openai-compatible provider — reasoning', () => {
  // cm:guard `reasoning_content` is the spelling this deployment's endpoints use, and the ONLY one
  // read. `delta.reasoning` is a second spelling in the wild that nobody here has measured, and
  // reading an unmeasured field is a guess (ISS-1079 decision 6).
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
