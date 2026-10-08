import type { StreamTextResult, ToolSet } from 'ai';
import { describe, expect, it } from 'vitest';
import { bridgeStream } from './ai-sdk.js';
import type { ChatStreamEvent } from './types.js';

// A chat turn offers the provider none of its own tools, so a tool the provider ran itself never
// reaches the turn loop as a call to execute: the bridge stops the round naming it.

const streamOf = (parts: unknown[]) =>
  ({
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
  }) as unknown as StreamTextResult<ToolSet, never, never>;

async function drain(parts: unknown[]): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of bridgeStream({
    label: 'provider',
    open: () => streamOf(parts),
    cachedFromRaw: () => undefined,
  })) {
    out.push(e);
  }
  return out;
}

describe('a provider-executed tool in a chat turn', () => {
  it('is refused by name, never handed to the loop as a call', async () => {
    const events = await drain([
      {
        type: 'tool-call',
        toolCallId: 'srv-1',
        toolName: 'code_execution',
        input: { command: 'ls' },
        providerExecuted: true,
      },
    ]);
    expect(events).toEqual([
      {
        type: 'error',
        message:
          'provider ran its own tool "code_execution", which a chat turn never offers; a computation runs through forge_compute',
      },
    ]);
  });

  it('leaves a client tool call as a call', async () => {
    const events = await drain([
      { type: 'tool-call', toolCallId: 't-1', toolName: 'forge_report', input: {} },
    ]);
    expect(events).toEqual([
      { type: 'tool_call', id: 't-1', name: 'forge_report', arguments: '{}' },
      { type: 'done' },
    ]);
  });
});
