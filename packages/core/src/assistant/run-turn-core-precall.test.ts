/**
 * ISS-1064 — the pre-call gate in the turn loop: a result it returns stands in for the call with
 * its own error flag and the tool never runs; null runs it; a gate that throws refuses the call
 * naming itself; and two note calls in one round are counted against each other, through the real
 * memory-note gate.
 */

import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '../mcp/tool-result.js';
import type { ChatProvider, ChatStreamEvent } from './providers/types.js';
import { runTurnEvents, type TurnCoreResult } from './run-turn-core.js';
import type { ChatToolset } from './tools/mcp-adapter.js';
import { memoryNotePreCall } from './tools/memory-note-gate.js';

const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });

async function drain(gen: AsyncGenerator<ChatStreamEvent, TurnCoreResult>) {
  const events: ChatStreamEvent[] = [];
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    step = await gen.next();
  }
  return { events, result: step.value };
}

function provider(rounds: ChatStreamEvent[][]): ChatProvider {
  let call = 0;
  return {
    id: 'mock',
    defaultModel: 'm',
    async *stream(): AsyncIterable<ChatStreamEvent> {
      const round = rounds[Math.min(call, rounds.length - 1)] ?? [{ type: 'done' }];
      call++;
      for (const e of round) yield e;
    },
  };
}
describe('preCall (ISS-1064)', () => {
  const note = {
    type: 'tool_call' as const,
    id: 'n1',
    name: 'forge_memory_note',
    arguments: '{"text":"x"}',
  };
  const rounds = [
    [note, { type: 'done' as const }],
    [{ type: 'chunk' as const, text: 'ok' }, { type: 'done' as const }],
  ];
  const toolsWith = (executed: string[]): ChatToolset => ({
    tools: [{ type: 'function', function: { name: 'forge_memory_note', parameters: {} } }],
    execute: async (name) => {
      executed.push(name);
      return ok('{"id":"m1"}');
    },
  });

  it('a result the gate returns stands in for the call with its own isError, and the tool never runs', async () => {
    for (const isError of [true, false]) {
      const executed: string[] = [];
      const seen: Array<{ name: string; messages: number; toolCalls: number }> = [];
      const { events, result } = await drain(
        runTurnEvents({
          provider: provider(rounds),
          model: 'm',
          messages: [{ role: 'user', content: 'remember x' }],
          tools: toolsWith(executed),
          preCall: async (call, ctx) => {
            seen.push({
              name: call.name,
              messages: ctx.messages.length,
              toolCalls: ctx.toolCalls.length,
            });
            return { content: [{ type: 'text', text: 'held' }], isError };
          },
        }),
      );
      expect(executed, String(isError)).toEqual([]);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toMatchObject({
        name: 'forge_memory_note',
        isError,
        resultPreview: 'held',
      });
      const fed = events.find((e) => e.type === 'tool_result');
      expect(fed).toMatchObject({ type: 'tool_result', id: 'n1', result: 'held', isError });
      expect(seen).toEqual([{ name: 'forge_memory_note', messages: 2, toolCalls: 0 }]);
      expect(result.finalText).toBe('ok');
    }
  });

  it('null lets the call run as before; a gate that throws refuses the call naming itself', async () => {
    const executed: string[] = [];
    const passed = await drain(
      runTurnEvents({
        provider: provider(rounds),
        model: 'm',
        messages: [{ role: 'user', content: 'remember x' }],
        tools: toolsWith(executed),
        preCall: async () => null,
      }),
    );
    expect(executed).toEqual(['forge_memory_note']);
    expect(passed.result.toolCalls[0]?.isError).toBe(false);

    const thrown = await drain(
      runTurnEvents({
        provider: provider(rounds),
        model: 'm',
        messages: [{ role: 'user', content: 'remember x' }],
        tools: toolsWith(executed),
        preCall: async () => {
          throw new Error('search exploded');
        },
      }),
    );
    expect(executed).toEqual(['forge_memory_note']);
    expect(thrown.result.toolCalls[0]?.isError).toBe(true);
    expect(thrown.result.toolCalls[0]?.resultPreview).toContain(
      'pre-call gate failed: search exploded',
    );
    expect(thrown.result.terminal).toBe('done');
  });
});

describe('two notes in one round (codex F1)', () => {
  it('the second note call of a one-sentence turn is refused in the same round, through the real gate', async () => {
    const executed: string[] = [];
    const tools: ChatToolset = {
      tools: [{ type: 'function', function: { name: 'forge_memory_note', parameters: {} } }],
      execute: async (_name, args) => {
        executed.push(args);
        return ok('{"id":"m"}');
      },
    };
    const { result } = await drain(
      runTurnEvents({
        provider: provider([
          [
            {
              type: 'tool_call',
              id: 'a',
              name: 'forge_memory_note',
              arguments: '{"text":"Release code name: bench-1a2b3c4d5e6f."}',
            },
            {
              type: 'tool_call',
              id: 'b',
              name: 'forge_memory_note',
              arguments: '{"text":"Code name for the release is bench-1a2b3c4d5e6f."}',
            },
            { type: 'done' },
          ],
          [{ type: 'chunk', text: 'kept' }, { type: 'done' }],
        ]),
        model: 'm',
        messages: [
          {
            role: 'user',
            content: 'Remember for this project: the release code name is bench-1a2b3c4d5e6f.',
          },
        ],
        tools,
        preCall: memoryNotePreCall({ existingNotes: async () => [] }),
      }),
    );
    expect(executed).toEqual(['{"text":"Release code name: bench-1a2b3c4d5e6f."}']);
    expect(result.toolCalls.map((c) => c.isError)).toEqual([false, true]);
    expect(result.toolCalls[1]?.resultPreview).toContain('(second_note_this_turn)');
  });
});
