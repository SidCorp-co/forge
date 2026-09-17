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

// cm:why its own file rather than a describe in `run-turn-core.test.ts`: that file is at its frozen
// size budget, and the budget's answer to a legitimate addition is a split —
// `run-turn-core-precall.test.ts` is the same split for the same reason.
// cm:guard this drain is a CLOSED if-chain with no final `else yield event`, so every member of
// ChatStreamEvent an adapter can emit needs an arm here or it is dropped between the provider and
// every observer with nothing on either side saying so. `reasoning` was added to the union by
// ISS-1079 and would have shown nothing on screen while passing every adapter test. These two cases
// are the only thing standing between that union and a silent drop.
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
