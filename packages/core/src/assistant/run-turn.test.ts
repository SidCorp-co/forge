import { describe, expect, it, vi } from 'vitest';

// cm:why the SSE callback is run against a fake stream, because what this file judges is the events
// a turn emits and their order, which no HTTP assertion over the body can separate from framing.
const captured: Array<{ event: string; data: string }> = [];
vi.mock('hono/streaming', () => ({
  streamSSE: async (
    _c: unknown,
    cb: (s: {
      writeSSE: (m: { event: string; data: string }) => Promise<void>;
      onAbort: (f: () => void) => void;
    }) => Promise<void>,
  ) => {
    const stream = {
      writeSSE: async (m: { event: string; data: string }) => {
        captured.push(m);
      },
      onAbort: () => {},
    };
    await cb(stream);
    return undefined;
  },
}));

// cm:why the audit row and the message rows both reach the database, and this file is about the SSE
// stream rather than either of them.
vi.mock('../db/client.js', () => ({
  db: { insert: () => ({ values: async () => undefined }) },
}));
const appended: string[] = [];
const silences: string[] = [];
vi.mock('./conversation-turn.js', () => ({
  appendAssistantMessage: (t: { pending: unknown[] }, text: string) => {
    appended.push(text);
    t.pending.push({ role: 'assistant', content: text });
  },
  appendSilence: (t: { pending: unknown[] }, reason: string) => {
    silences.push(reason);
    t.pending.push({ role: 'assistant', content: '', silenceReason: reason });
  },
  persistMessages: async () => undefined,
}));

const { runChatTurn } = await import('./run-turn.js');

import type { ConversationTurn } from './conversation-turn.js';
import type { ChatProvider, ChatStreamEvent } from './providers/types.js';
import type { ChatToolset } from './tools/mcp-adapter.js';

function fakeCtx() {
  return { header: () => {} } as never;
}

function turn(): ConversationTurn {
  return { conversationId: 'c1', adapter: 'web', history: [], pending: [] };
}

describe('runChatTurn tool loop', () => {
  it('executes a requested tool then re-invokes the provider for the final answer', async () => {
    captured.length = 0;
    appended.length = 0;

    // Turn 1 → asks for a tool. Turn 2 → plain answer.
    let call = 0;
    const provider: ChatProvider = {
      id: 'mock',
      defaultModel: 'm',
      async *stream(): AsyncIterable<ChatStreamEvent> {
        call++;
        if (call === 1) {
          yield {
            type: 'tool_call',
            id: 'c1',
            name: 'forge_issues',
            arguments: '{"action":"list"}',
          };
          yield { type: 'done' };
        } else {
          yield { type: 'chunk', text: 'You have 2 open issues.' };
          yield { type: 'done' };
        }
      },
    };

    let executedWith: { name: string; args: string } | null = null;
    const tools: ChatToolset = {
      tools: [
        { type: 'function', function: { name: 'forge_issues', parameters: { type: 'object' } } },
      ],
      execute: async (name, argsJson) => {
        executedWith = { name, args: argsJson };
        return { content: [{ type: 'text', text: '{"items":[{"id":1},{"id":2}]}' }] };
      },
    };

    await runChatTurn({
      c: fakeCtx(),
      turn: turn(),
      resolved: { provider, model: 'm' },
      providerMessages: [{ role: 'user', content: 'how many open issues?' }],
      tools,
      projectSlug: 'proj',
      userMessage: 'how many open issues?',
      userKey: 'u1',
      adapter: 'web',
    });

    // The tool ran with the model's arguments.
    expect(executedWith).toEqual({ name: 'forge_issues', args: '{"action":"list"}' });

    const kinds = captured.map((e) => e.event);
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('tool_result');
    // Exactly one terminal `done` for the whole loop.
    expect(kinds.filter((k) => k === 'done')).toHaveLength(1);
    // Only the final (post-tool) assistant text is persisted.
    expect(appended).toEqual(['You have 2 open issues.']);

    const provider_called_twice = call === 2;
    expect(provider_called_twice).toBe(true);
  });

  it('finalizes immediately when no tool is requested', async () => {
    captured.length = 0;
    appended.length = 0;

    const provider: ChatProvider = {
      id: 'mock',
      defaultModel: 'm',
      async *stream(): AsyncIterable<ChatStreamEvent> {
        yield { type: 'chunk', text: 'hi' };
        yield { type: 'done' };
      },
    };

    await runChatTurn({
      c: fakeCtx(),
      turn: turn(),
      resolved: { provider, model: 'm' },
      providerMessages: [{ role: 'user', content: 'hi' }],
      tools: { tools: [], execute: async () => ({ content: [] }) },
      projectSlug: 'proj',
      userMessage: 'hi',
      userKey: 'u1',
      adapter: 'web',
    });

    expect(appended).toEqual(['hi']);
    expect(captured.filter((e) => e.event === 'done')).toHaveLength(1);
    expect(captured.some((e) => e.event === 'tool_result')).toBe(false);
  });
});
