// A round whose stream breaks partway is asked again once, and a turn that still breaks keeps the
// draft it had streamed (dev QA 2026-10-07: a long spec streamed for ~45 s, its stream broke, and
// the turn ended ASSISTANT_TURN_FAILED with every word of it thrown away). The provider is the one
// thing scripted: each request streams its text, then ends or breaks.

import { describe, expect, it } from 'vitest';
import type { ChatStreamEvent } from '../integrations/llm/index.js';
import type { ChatStreamRequest } from '../integrations/llm/types.js';
import { runTurnEvents, type TurnCoreResult } from './run-turn-core.js';
import { TranscriptAccumulator } from './transcript-entry.js';

type Request = { text: string; breaks?: string };

function scripted(requests: Request[]) {
  const seen: ChatStreamRequest[] = [];
  return {
    seen,
    provider: {
      id: 'scripted',
      defaultModel: 'scripted',
      async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
        seen.push(req);
        const next = requests.shift();
        if (!next) throw new Error('the test scripted no further request');
        for (const word of next.text.split(/(?<= )/)) yield { type: 'chunk', text: word };
        if (next.breaks) {
          yield { type: 'error', message: next.breaks };
          return;
        }
        yield { type: 'done' };
      },
    },
  };
}

async function drain(requests: Request[], signal?: AbortSignal) {
  const { provider, seen } = scripted(requests);
  const events: ChatStreamEvent[] = [];
  const gen = runTurnEvents({
    provider,
    model: 'scripted',
    messages: [{ role: 'user', content: 'Soạn giúp mình một spec issue thật dài.' }], // i18n-allow: the Vietnamese turn replayed as the test case
    ...(signal ? { signal } : {}),
  });
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    step = await gen.next();
  }
  return { result: step.value as TurnCoreResult, events, seen };
}

const SPEC = '1. Bối cảnh: người quản lý dự án cần một báo cáo tuần. 2. Mục tiêu: '; // i18n-allow: the Vietnamese turn replayed as the test case

describe('a round whose stream breaks partway', () => {
  it('is asked again once, and the turn ends with the answer the second request gave', async () => {
    const { result, events, seen } = await drain([
      { text: SPEC, breaks: 'anthropic stream ended: overloaded_error' },
      { text: `${SPEC}xuất PDF trong một lần bấm.` }, // i18n-allow: the Vietnamese turn replayed as the test case
    ]);
    expect(seen).toHaveLength(2);
    expect(events.map((e) => e.type)).toContain('round_retry');
    expect(result.terminal).toBe('done');
    expect(result.finalText).toBe(`${SPEC}xuất PDF trong một lần bấm.`); // i18n-allow: the Vietnamese turn replayed as the test case
  });

  it('that breaks again ends the turn, keeping the draft it streamed and naming the provider', async () => {
    const { result, seen } = await drain([
      { text: SPEC, breaks: 'stream disconnected' },
      { text: '1. Bối cảnh', breaks: 'stream disconnected' }, // i18n-allow: the Vietnamese turn replayed as the test case
    ]);
    expect(seen).toHaveLength(2);
    expect(result).toMatchObject({
      terminal: 'error',
      errorSource: 'provider',
      finalText: '',
      partialText: SPEC,
    });
  });

  it('is not asked again once the turn was aborted: a stop or the ceiling is not a broken stream', async () => {
    const abort = new AbortController();
    abort.abort();
    const { result, seen } = await drain([{ text: SPEC, breaks: 'request aborted' }], abort.signal);
    expect(seen).toHaveLength(1);
    expect(result).toMatchObject({ terminal: 'error', partialText: SPEC });
  });
});

describe('the live entry of a round asked again', () => {
  it('takes back what the broken attempt streamed, so the reader sees the answer once', () => {
    const acc = new TranscriptAccumulator('entry-1');
    acc.apply({ type: 'tool_call', id: 't-1', name: 'forge_knowledge', arguments: '{}' });
    acc.apply({ type: 'tool_result', id: 't-1', result: 'knowledge' });
    acc.apply({ type: 'chunk', text: SPEC });
    acc.apply({ type: 'error', message: 'stream disconnected' });
    acc.apply({ type: 'round_retry', message: 'stream disconnected' });
    acc.apply({ type: 'chunk', text: 'Bản spec:' }); // i18n-allow: the Vietnamese turn replayed as the test case
    expect(acc.entry()?.content).toBe('Bản spec:'); // i18n-allow: the Vietnamese turn replayed as the test case
    expect(acc.blocks()?.map((b) => b.type)).toEqual(['tool', 'text']);
  });
});
