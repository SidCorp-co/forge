/**
 * ISS-1001 — what a turn hands the provider.
 *
 * `openTurn` is a transaction against real tables and is walked in
 * `tests/integration/conversation-scope-e2e.test.ts`, including the two
 * refusals it owes. What lives here is the projection, whose failures are all
 * silent by nature: a dropped message does not error, it just is not in the
 * prompt, and the model answers as if it had never been sent.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../conversations/store.js', () => ({
  readMessages: async () => [],
  openConversation: async () => ({}),
}));
vi.mock('../conversations/scope.js', () => ({ assertConversationReadable: async () => [] }));

const { toProviderMessages } = await import('./conversation-turn.js');

const IMAGE = { name: 'shot.png', mime: 'image/png', ref: 'att-1' };

function turn(history: unknown[] = [], pending: unknown[] = []) {
  return { conversationId: 'c1', adapter: 'web' as const, history, pending } as never;
}

function stored(over: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    seq: 0,
    role: 'user',
    authorUserId: null,
    authorLabel: null,
    content: 'hello',
    images: [],
    deliveryProof: null,
    silenceReason: null,
    createdAt: new Date(),
    ...over,
  };
}

describe('toProviderMessages', () => {
  it('sends the history and this turn, in that order', () => {
    const out = toProviderMessages(
      turn([stored({ content: 'earlier' })], [{ ...stored({ content: 'now' }), images: [] }]),
    );
    expect(out).toEqual([
      { role: 'user', content: 'earlier' },
      { role: 'user', content: 'now' },
    ]);
  });

  // cm:guard a silence is a ROW and never a prompt: replaying it as an empty assistant turn teaches
  // the model that an empty answer is a shape it may produce.
  it('leaves a recorded silence out of the prompt', () => {
    const out = toProviderMessages(
      turn([
        stored({ content: 'asked' }),
        stored({ role: 'assistant', content: '', silenceReason: 'turn threw' }),
      ]),
    );
    expect(out).toEqual([{ role: 'user', content: 'asked' }]);
  });

  // cm:guard an image with NO caption is the commonest way a person asks about a screenshot, and a
  // length test on the text alone drops it — the model is asked about a picture it was never shown.
  it('sends a captionless image as its own content part', () => {
    const out = toProviderMessages(
      turn([], [stored({ content: '', images: [IMAGE] })]),
      new Map([['att-1', 'https://example.test/shot.png']]),
    );
    expect(out).toEqual([
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://example.test/shot.png' } }],
      },
    ]);
  });

  it('keeps the caption beside the image when there is one', () => {
    const out = toProviderMessages(
      turn([], [stored({ content: 'what is this?', images: [IMAGE] })]),
      new Map([['att-1', 'https://example.test/shot.png']]),
    );
    expect(out[0]?.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'https://example.test/shot.png' } },
    ]);
  });

  it('drops an empty message whose image could not be resolved, rather than sending nothing', () => {
    const out = toProviderMessages(turn([], [stored({ content: '', images: [IMAGE] })]), new Map());
    expect(out).toEqual([]);
  });

  it('sends a historical image the same way as one from this turn', () => {
    const out = toProviderMessages(
      turn([stored({ content: '', images: [IMAGE] })]),
      new Map([['att-1', 'https://example.test/shot.png']]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toEqual([
      { type: 'image_url', image_url: { url: 'https://example.test/shot.png' } },
    ]);
  });
});
