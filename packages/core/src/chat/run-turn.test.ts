import { describe, expect, it, vi } from 'vitest';

// Capture SSE events by running the streamSSE callback against a fake stream.
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

// chat_logs audit + session persistence both touch the DB — stub them out.
vi.mock('../db/client.js', () => ({
  db: { insert: () => ({ values: async () => undefined }) },
}));
const appended: string[] = [];
vi.mock('./session.js', () => ({
  appendAssistantMessage: (s: { messages: unknown[] }, text: string) => {
    appended.push(text);
    s.messages.push({ role: 'assistant', content: text });
  },
  persistMessages: async () => undefined,
}));

const { runChatTurn } = await import('./run-turn.js');
import type { ChatProvider, ChatStreamEvent } from './providers/types.js';
import type { ChatSessionRow } from './session.js';
import type { ChatToolset } from './tools/mcp-adapter.js';

function fakeCtx() {
  return { header: () => {} } as never;
}

function session(): ChatSessionRow {
  return { id: 's1', projectId: 'p1', userId: 'u1', source: 'web', messages: [] };
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
        return '{"items":[{"id":1},{"id":2}]}';
      },
    };

    await runChatTurn({
      c: fakeCtx(),
      session: session(),
      resolved: { provider, model: 'm' },
      providerMessages: [{ role: 'user', content: 'how many open issues?' }],
      tools,
      projectSlug: 'proj',
      userMessage: 'how many open issues?',
      userKey: 'u1',
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
      session: session(),
      resolved: { provider, model: 'm' },
      providerMessages: [{ role: 'user', content: 'hi' }],
      tools: { tools: [], execute: async () => '{}' },
      projectSlug: 'proj',
      userMessage: 'hi',
      userKey: 'u1',
    });

    expect(appended).toEqual(['hi']);
    expect(captured.filter((e) => e.event === 'done')).toHaveLength(1);
    expect(captured.some((e) => e.event === 'tool_result')).toBe(false);
  });
});
