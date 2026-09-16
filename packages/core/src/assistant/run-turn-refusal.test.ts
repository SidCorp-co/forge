/**
 * ISS-1029 — what a turn does when the transcript refuses an event.
 *
 * The accumulator refuses a tool result naming no call this turn made, by name
 * (`transcript-entry.test.ts` proves the refusal itself). This file is about the
 * other half: the refusal must end the TURN loudly without taking the user's own
 * message down with it. The user message is still unwritten at that point — it
 * lives in `turn.pending` until `persistMessages` runs — so a throw escaping the
 * stream callback would answer a broken pairing by deleting the question too,
 * which is the failure ISS-1001 invariant 7 exists to prevent.
 */

import { describe, expect, it, vi } from 'vitest';

const captured: Array<{ event: string; data: string }> = [];
vi.mock('hono/streaming', () => ({
  streamSSE: async (
    _c: unknown,
    cb: (s: {
      writeSSE: (m: { event: string; data: string }) => Promise<void>;
      onAbort: (f: () => void) => void;
    }) => Promise<void>,
  ) => {
    await cb({
      writeSSE: async (m) => {
        captured.push(m);
      },
      onAbort: () => {},
    });
    return undefined;
  },
}));

const logged: Array<Record<string, unknown>> = [];
vi.mock('../db/client.js', () => ({
  db: {
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        logged.push(v);
      },
    }),
  },
}));

const persisted: Array<Record<string, unknown>> = [];
vi.mock('./conversation-turn.js', () => ({
  appendAssistantMessage: (t: { pending: unknown[] }, content: string) => {
    t.pending.push({ role: 'assistant', content, silenceReason: null, blocks: null });
  },
  appendSilence: (t: { pending: unknown[] }, reason: string, opts?: { blocks?: unknown }) => {
    t.pending.push({
      role: 'assistant',
      content: '',
      silenceReason: reason,
      blocks: opts?.blocks ?? null,
    });
  },
  persistMessages: async (t: { pending: Array<Record<string, unknown>> }) => {
    const rows = t.pending.splice(0).map((m, i) => ({
      id: `row-${i}`,
      seq: i,
      role: m.role,
      content: m.content,
      blocks: m.blocks ?? null,
      silenceReason: m.silenceReason ?? null,
      createdAt: new Date(0),
      externalId: null,
      authorUserId: null,
      authorLabel: null,
      authorKey: null,
      images: [],
      deliveryProof: null,
    }));
    persisted.push(...rows);
    return rows;
  },
  toCanonicalEntry: (row: Record<string, unknown>) => ({ id: row.id, type: 'assistant' }),
}));

// cm:why the accumulator is doubled to REFUSE: the real loop pairs every result with the call it
// executed, so an unmatched id cannot be provoked through a provider — and the point here is what
// `runChatTurn` does with a refusal, not whether the accumulator makes one.
vi.mock('./transcript-entry.js', () => ({
  createTranscriptAccumulator: () => ({
    apply: (e: { type: string }) => {
      if (e.type === 'tool_result') {
        throw new Error('transcript: tool result for zz names no tool call this turn made');
      }
    },
    entry: () => null,
    blocks: () => null,
  }),
}));

const { runChatTurn } = await import('./run-turn.js');

import type { ConversationTurn } from './conversation-turn.js';
import type { ChatProvider, ChatStreamEvent } from './providers/types.js';
import type { ChatToolset } from './tools/mcp-adapter.js';

describe('a transcript refusal ends the turn without losing it', () => {
  it('records the refusal verbatim and still writes the row', async () => {
    captured.length = 0;
    persisted.length = 0;
    logged.length = 0;

    let call = 0;
    const provider: ChatProvider = {
      id: 'mock',
      defaultModel: 'm',
      async *stream(): AsyncIterable<ChatStreamEvent> {
        call++;
        if (call === 1) {
          yield { type: 'tool_call', id: 'c1', name: 'forge_issues', arguments: '{}' };
          yield { type: 'done' };
        } else {
          yield { type: 'chunk', text: 'never reached' };
          yield { type: 'done' };
        }
      },
    };
    const tools: ChatToolset = {
      tools: [
        { type: 'function', function: { name: 'forge_issues', parameters: { type: 'object' } } },
      ],
      execute: async () => ({ content: [{ type: 'text', text: 'two' }] }),
    };

    const turn: ConversationTurn = {
      conversationId: 'c1',
      adapter: 'web',
      handleUserId: null,
      history: [],
      pending: [{ role: 'user', content: 'how many?' } as never],
    };

    // The turn does not throw out of the stream.
    await runChatTurn({
      c: { header: () => {} } as never,
      turn,
      projectId: 'p1',
      resolved: { provider, model: 'm' },
      providerMessages: [{ role: 'user', content: 'how many?' }],
      tools,
      projectSlug: 'proj',
      userMessage: 'how many?',
      userKey: 'u1',
      adapter: 'web',
    });

    // cm:guard the user's message reached the table: without this the refusal would be a worse
    // defect than the one it refuses — a question with no record that it was ever asked.
    expect(persisted.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(persisted[0]?.content).toBe('how many?');

    // The refusal is the turn's recorded reason, named, not swallowed into a generic failure.
    expect(persisted[1]?.silenceReason).toContain('names no tool call');

    // And the reader is told on the stream too.
    const errorFrame = captured.find((e) => e.data.includes('names no tool call'));
    expect(errorFrame?.event).toBe('message');
    expect(errorFrame?.data).toContain('"subtype":"error"');

    // The audit row still lands, carrying the same reason.
    expect(logged).toHaveLength(1);
    expect(logged[0]?.error).toContain('names no tool call');
  });
});
