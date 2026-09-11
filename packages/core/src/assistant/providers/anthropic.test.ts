import { describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider, toAnthropicMessages, toRequestBody } from './anthropic.js';
import type { ChatMessage, ChatStreamEvent } from './types.js';

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

const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const ok = (events: string[]) =>
  new Response(sseBody(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const provider = (fetchImpl: unknown, retryDelaysMs = [0, 0]) =>
  createAnthropicProvider({
    baseUrl: 'https://an.test/',
    apiKey: 'ak',
    defaultModel: 'claude',
    fetchImpl: fetchImpl as typeof fetch,
    retryDelaysMs,
  });
const sentBody = (fetchImpl: ReturnType<typeof vi.fn>, i = 0) =>
  JSON.parse(((fetchImpl.mock.calls[i] as unknown[])[1] as RequestInit).body as string) as Record<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: wire body under test
    any
  >;

describe('toAnthropicMessages', () => {
  it('hoists system text, keeps user/assistant turns and puts tool replies in the next user turn', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'calling',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'get', arguments: '{"a":1}' } },
          { id: 'c2', type: 'function', function: { name: 'get', arguments: 'not json' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'tool', tool_call_id: 'c2', content: 'r2' },
      { role: 'assistant', content: 'done' },
    ];
    const out = toAnthropicMessages(messages);
    expect(out.system).toBe('SYS');
    expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(out.messages[1]?.content).toEqual([
      { type: 'text', text: 'calling' },
      { type: 'tool_use', id: 'c1', name: 'get', input: { a: 1 } },
      { type: 'tool_use', id: 'c2', name: 'get', input: {} },
    ]);
    expect(out.messages[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: 'r1' },
      { type: 'tool_result', tool_use_id: 'c2', content: 'r2' },
    ]);
  });

  it('merges consecutive same-role turns and drops a leading assistant turn', () => {
    const out = toAnthropicMessages([
      { role: 'assistant', content: 'orphan' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: '' },
    ]);
    expect(out.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      },
    ]);
  });

  it('turns a data-URI image part into a base64 image block', () => {
    const out = toAnthropicMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
          { type: 'image_url', image_url: { url: 'https://remote/x.png' } },
        ],
      },
    ]);
    expect(out.messages[0]?.content).toEqual([
      { type: 'text', text: 'see' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      { type: 'text', text: '[image omitted: not a data: URI]' },
    ]);
  });
});

describe('toRequestBody', () => {
  const req = {
    model: 'claude',
    messages: [
      { role: 'system', content: 'SYS' } as ChatMessage,
      { role: 'user', content: 'hi' } as ChatMessage,
    ],
    tools: [
      {
        type: 'function' as const,
        function: { name: 'a', description: 'A', parameters: { properties: {} } },
      },
      {
        type: 'function' as const,
        function: { name: 'b', parameters: { type: 'object', properties: {} } },
      },
    ],
    temperature: 0.2,
  };

  it('maps tools, marks the system block and the LAST tool for caching, and maps tool_choice', () => {
    const body = toRequestBody(req, 500, 'required');
    expect(body.max_tokens).toBe(500);
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.2);
    expect(body.system).toEqual([
      { type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.tools).toEqual([
      { name: 'a', description: 'A', input_schema: { type: 'object', properties: {} } },
      {
        name: 'b',
        input_schema: { type: 'object', properties: {} },
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: 'any' });
    expect(toRequestBody(req, 500, 'auto').tool_choice).toEqual({ type: 'auto' });
    expect(toRequestBody(req, 500, undefined)).not.toHaveProperty('tool_choice');
  });

  it('renders response_format as a second, uncached system block', () => {
    const body = toRequestBody(
      {
        ...req,
        tools: undefined,
        responseFormat: {
          type: 'json_schema',
          json_schema: { name: 'x', schema: { type: 'object' } },
        },
      },
      500,
      undefined,
    );
    const system = body.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system).toHaveLength(2);
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[1]?.text).toContain('{"type":"object"}');
    expect(system[1]).not.toHaveProperty('cache_control');
    expect(body).not.toHaveProperty('tools');
  });
});

describe('anthropic provider — stream', () => {
  it('emits text chunks, reassembled tool calls, usage and done, and ignores thinking blocks', async () => {
    const fetchImpl = vi.fn(async () =>
      ok([
        frame({
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 90,
              cache_creation_input_tokens: 0,
            },
          },
        }),
        frame({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        }),
        frame({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'hmm' },
        }),
        frame({ type: 'content_block_stop', index: 0 }),
        frame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
        frame({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'Hel' },
        }),
        frame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } }),
        frame({ type: 'content_block_stop', index: 1 }),
        frame({
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 't1', name: 'get', input: {} },
        }),
        frame({
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"ci' },
        }),
        frame({
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: 'ty":"Hanoi"}' },
        }),
        frame({ type: 'content_block_stop', index: 2 }),
        frame({
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 7 },
        }),
        frame({ type: 'message_stop' }),
        'data: [DONE]\n\n',
      ]),
    );
    const events = await collect(
      provider(fetchImpl).stream({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(events).toEqual([
      { type: 'chunk', text: 'Hel' },
      { type: 'chunk', text: 'lo' },
      { type: 'tool_call', id: 't1', name: 'get', arguments: '{"city":"Hanoi"}' },
      {
        type: 'usage',
        usage: { promptTokens: 100, completionTokens: 7, totalTokens: 107, cachedPromptTokens: 90 },
      },
      { type: 'done' },
    ]);
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe('https://an.test/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('ak');
    expect((init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
    expect(sentBody(fetchImpl).max_tokens).toBe(8192);
  });

  it('a tool_use with no arguments yields `{}`, and a stream that ends without content_block_stop still flushes it', async () => {
    const fetchImpl = vi.fn(async () =>
      ok([
        frame({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't1', name: 'ping', input: {} },
        }),
        frame({ type: 'message_stop' }),
      ]),
    );
    const events = await collect(
      provider(fetchImpl).stream({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(events).toEqual([
      { type: 'tool_call', id: 't1', name: 'ping', arguments: '{}' },
      { type: 'done' },
    ]);
  });

  it('turns an in-stream error event into the terminal error', async () => {
    const fetchImpl = vi.fn(async () =>
      ok([
        frame({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'par' },
        }),
        frame({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
      ]),
    );
    const events = await collect(
      provider(fetchImpl).stream({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(events).toEqual([
      { type: 'chunk', text: 'par' },
      { type: 'error', message: 'Overloaded' },
    ]);
  });

  it('retries a 529 before the stream opens and reports a non-retryable 4xx at once', async () => {
    const flaky = vi.fn(async () =>
      flaky.mock.calls.length === 1
        ? new Response('{"type":"error"}', { status: 529 })
        : ok([frame({ type: 'message_stop' })]),
    );
    expect(
      await collect(
        provider(flaky).stream({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
      ),
    ).toEqual([{ type: 'done' }]);
    expect(flaky).toHaveBeenCalledTimes(2);

    const denied = vi.fn(async () => new Response('bad key', { status: 401 }));
    const events = await collect(
      provider(denied).stream({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(denied).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ type: 'error', message: 'anthropic http 401: bad key' }]);
  });

  it('drops tool_choice and retries once when the endpoint rejects it', async () => {
    const fetchImpl = vi.fn(async () =>
      fetchImpl.mock.calls.length === 1
        ? new Response('{"error":{"message":"tool_choice is not supported"}}', { status: 400 })
        : ok([frame({ type: 'message_stop' })]),
    );
    await collect(
      provider(fetchImpl).stream({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'a', parameters: {} } }],
        toolChoice: 'required',
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchImpl, 0).tool_choice).toEqual({ type: 'any' });
    expect(sentBody(fetchImpl, 1)).not.toHaveProperty('tool_choice');
  });
});
