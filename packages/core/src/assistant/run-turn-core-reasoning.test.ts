import { describe, expect, it } from 'vitest';
import type { ChatProvider, ChatStreamEvent } from './providers/types.js';
import { runTurnEvents, type TurnCoreResult } from './run-turn-core.js';

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

describe('runTurnEvents — reasoning passes through', () => {
  it('yields a reasoning event onward, in the order the provider sent it', async () => {
    const { events, result } = await drain(
      runTurnEvents({
        provider: provider([
          [
            { type: 'reasoning', text: 'let me check' },
            { type: 'chunk', text: 'Two left.' },
            { type: 'done' },
          ],
        ]),
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(events).toEqual([
      { type: 'reasoning', text: 'let me check' },
      { type: 'chunk', text: 'Two left.' },
      { type: 'done' },
    ]);
    expect(result.finalText).toBe('Two left.');
  });

  it('yields a redacted reasoning event onward with its marker intact', async () => {
    const { events } = await drain(
      runTurnEvents({
        provider: provider([
          [
            { type: 'reasoning', text: '', redacted: true },
            { type: 'chunk', text: 'ok' },
            { type: 'done' },
          ],
        ]),
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(events[0]).toEqual({ type: 'reasoning', text: '', redacted: true });
  });

  it('does not count reasoning text as the turn answer', async () => {
    const { result } = await drain(
      runTurnEvents({
        provider: provider([[{ type: 'reasoning', text: 'thinking out loud' }, { type: 'done' }]]),
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(result.finalText).toBe('');
  });
});
