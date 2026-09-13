/**
 * ISS-1001 — what a turn hands the provider.
 *
 * `openTurn` is a transaction against real tables and is walked in
 * `tests/integration/conversation-scope-e2e.test.ts`, including the two
 * refusals it owes. What lives here is the projection, whose failures are all
 * silent by nature: a dropped message does not error, it just is not in the
 * prompt, and the model answers as if it had never been sent.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../conversations/store.js', () => ({
  readMessages: async () => [],
  openConversation: async () => ({}),
}));
vi.mock('../conversations/scope.js', () => ({ assertConversationReadable: async () => [] }));

const { appendAssistantMessage, appendSilence, toProviderMessages } = await import(
  './conversation-turn.js'
);

const IMAGE = { name: 'shot.png', mime: 'image/png', ref: 'att-1' };

function turn(
  history: unknown[] = [],
  pending: unknown[] = [],
  handleUserId: string | null = null,
) {
  return { conversationId: 'c1', adapter: 'web' as const, handleUserId, history, pending } as never;
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

// cm:guard a silence is a handle DECLINING to speak, so it is by that handle: an unattributed one
// cannot say which of a room's two handles went quiet, which is the distinction the row exists for.
describe('a silence names the handle that stayed quiet', () => {
  it('is authored by the room handle, exactly as an answer would have been', () => {
    const t = turn([], [], 'handle-1');
    appendSilence(t, 'provider timed out');
    appendAssistantMessage(t, 'an answer');
    const [silence, answer] = (t as unknown as { pending: Array<Record<string, unknown>> }).pending;
    expect(silence).toMatchObject({
      role: 'assistant',
      content: '',
      silenceReason: 'provider timed out',
      authorUserId: 'handle-1',
    });
    expect(answer?.authorUserId).toBe('handle-1');
  });

  it('is by nobody only where the room itself has no handle', () => {
    const t = turn([], [], null);
    appendSilence(t, 'no answer');
    expect(
      (t as unknown as { pending: Array<Record<string, unknown>> }).pending[0]?.authorUserId,
    ).toBeNull();
  });
});

// cm:guard a persisted turn names the authority it runs as — structural, because the call sites are
// what regress: `connection-manager.ts` omitted it and every mocked suite stayed green (ISS-1001)
describe('every persisted turn names its authority', () => {
  it('passes a userId wherever it passes a conversation or a venue', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const offences: string[] = [];
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(`${dir}${e.name}/`)
          : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')
            ? [`${dir}${e.name}`]
            : [],
      );
    for (const file of walk(root)) {
      const text = readFileSync(file, 'utf8');
      for (const call of text.matchAll(/runExternalChatTurn\(\{([\s\S]*?)\n\s*\}\)/g)) {
        const body = call[1] ?? '';
        const addressed = /\b(conversationId|externalId):/.test(body);
        if (!addressed) continue;
        if (!/\buserId:/.test(body)) {
          offences.push(`${file.slice(root.length)} names a room and no userId`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});
