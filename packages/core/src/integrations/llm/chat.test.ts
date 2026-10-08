import { describe, expect, it } from 'vitest';
import { completeOnce } from './chat.js';
import { register } from './registry.js';
import type { ChatStreamEvent } from './types.js';

// `completeOnce` is a chat turn's provider path with no tools: the same `openChat` gate, drained to
// text and usage, and a miss named rather than thrown.

const said = [{ role: 'user' as const, content: 'rows' }];
const scope = { surface: 'conversation' as const, level: 'off' as const };

describe('completeOnce', () => {
  it('names a missing provider as unconfigured', async () => {
    const answer = await completeOnce(scope, said);
    expect(answer).toMatchObject({ ok: false, miss: 'unconfigured', model: null });
  });

  it('drains the stream to its text and its summed usage, under the provider model', async () => {
    let streamed: ChatStreamEvent[] = [];
    register('anthropic', () => ({
      id: 'scripted',
      defaultModel: 'scripted-model',
      async *stream() {
        for (const e of streamed) yield e;
      },
    }));
    streamed = [
      { type: 'chunk', text: 'Work is ' },
      { type: 'usage', usage: { promptTokens: 10, completionTokens: 2 } },
      { type: 'chunk', text: 'under way.' },
      { type: 'usage', usage: { promptTokens: 5, cachedPromptTokens: 4 } },
      { type: 'done' },
    ];
    expect(await completeOnce(scope, said)).toEqual({
      ok: true,
      text: 'Work is under way.',
      model: 'scripted-model',
      usage: { promptTokens: 15, completionTokens: 2, cachedPromptTokens: 4 },
    });

    streamed = [
      { type: 'chunk', text: 'half' },
      { type: 'error', message: '429 quota exceeded' },
    ];
    expect(await completeOnce(scope, said)).toEqual({
      ok: false,
      miss: 'failed',
      detail: '429 quota exceeded',
      model: 'scripted-model',
    });

    streamed = [{ type: 'done' }];
    expect(await completeOnce(scope, said)).toMatchObject({ ok: false, miss: 'failed' });
  });

  it('sends nothing where the policy withholds the surface', async () => {
    let called = false;
    register('anthropic', () => ({
      id: 'scripted',
      defaultModel: 'scripted-model',
      async *stream() {
        called = true;
        yield { type: 'done' } as const;
      },
    }));
    const answer = await completeOnce({ surface: 'conversation', level: 'no_egress' }, said);
    expect(answer).toMatchObject({ ok: false, miss: 'withheld', model: null });
    expect(called).toBe(false);
  });
});
