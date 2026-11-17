// `VISION: kernel-hard-policy-soft` (ISS-1251): a memory note the assistant writes is never refused
// for its content. The rule it breaks is put before what the note tool answered, and the tool runs.
import { describe, expect, it } from 'vitest';
import type { ChatProvider, ChatStreamEvent } from '../../integrations/llm/index.js';
import { runTurnEvents } from '../run-turn-core.js';
import { memoryNotePreCall } from './memory-note-gate.js';

const NOTE = 'Release code name: bench-1a2b3c.';

/** One turn in which the model writes NOTE once, then answers. */
async function noteTurn(existing: { text: string; score: number }[]) {
  let round = 0;
  const provider: ChatProvider = {
    id: 'stub',
    defaultModel: 'stub',
    async *stream(): AsyncIterable<ChatStreamEvent> {
      round++;
      if (round === 1) {
        yield {
          type: 'tool_call',
          id: 'n1',
          name: 'forge_memory_note',
          arguments: JSON.stringify({ text: NOTE }),
        };
      } else yield { type: 'chunk', text: 'Noted.' };
    },
  };
  const written: string[] = [];
  const tools = {
    tools: [
      {
        type: 'function' as const,
        function: { name: 'forge_memory_note', description: '', parameters: {} },
      },
    ],
    ranAs: () => null,
    execute: async (_name: string, args: string) => {
      written.push(args);
      return { content: [{ type: 'text' as const, text: '{"id":"note-1"}' }] };
    },
  };
  const events: ChatStreamEvent[] = [];
  const turn = runTurnEvents({
    provider,
    model: 'stub',
    messages: [{ role: 'user', content: 'Remember: the release code name is bench-1a2b3c.' }],
    tools: tools as never,
    preCall: memoryNotePreCall({ existingNotes: async () => existing }),
  });
  for (let next = await turn.next(); !next.done; next = await turn.next()) events.push(next.value);
  const result = events.find(
    (e): e is Extract<ChatStreamEvent, { type: 'tool_result' }> => e.type === 'tool_result',
  );
  return { written, result };
}

describe('a memory note the assistant writes', () => {
  it('is written beside the rule it breaks, never refused for it', async () => {
    const { written, result } = await noteTurn([{ text: NOTE, score: 0.97 }]);
    expect(written, 'the note tool ran: a broken rule refuses nothing').toHaveLength(1);
    expect(result?.isError).toBe(false);
    const text = String(result?.result);
    expect(text.startsWith('Note finding (duplicate): the project already holds this')).toBe(true);
    expect(text).toContain('{"id":"note-1"}');
  });

  it('is written with no notice where it breaks no rule', async () => {
    const { written, result } = await noteTurn([]);
    expect(written).toHaveLength(1);
    expect(String(result?.result)).toBe('{"id":"note-1"}');
  });
});
