/**
 * ISS-1001 — the part of the store that is not the database.
 *
 * Everything else in `store.ts` is a transaction whose claims are about
 * Postgres — the unique index, `FOR UPDATE`, `max(seq)+1` under two writers —
 * and a mocked drizzle chain would assert the mock rather than the row. Those
 * are walked in `tests/integration/conversation-store-e2e.test.ts`. What lives
 * here is the reader that has to survive a column nobody validated on the way
 * in.
 */

import { describe, expect, it, vi } from 'vitest';

// cm:why `store.ts` opens the pool at import and this reader needs no connection
vi.mock('../db/client.js', () => ({ db: {} }));

const { asBlocks, asImages, toCanonicalEntry } = await import('./store.js');

describe('asImages', () => {
  it('reads the images a turn wrote', () => {
    expect(asImages([{ name: 'a.png', mime: 'image/png', ref: 'att-1' }])).toEqual([
      { name: 'a.png', mime: 'image/png', ref: 'att-1' },
    ]);
  });

  it('answers empty for a column that is not an array', () => {
    for (const v of [null, undefined, {}, 'att-1', 3, true]) {
      expect(asImages(v)).toEqual([]);
    }
  });

  it('drops the entries it cannot read and keeps the ones it can', () => {
    expect(
      asImages([
        null,
        'att-1',
        { name: 'a.png', mime: 'image/png' },
        { name: 'b.png', mime: 'image/png', ref: '' },
        { name: 1, mime: 'image/png', ref: 'att-2' },
        { name: 'c.png', mime: 'image/png', ref: 'att-3' },
      ]),
    ).toEqual([{ name: 'c.png', mime: 'image/png', ref: 'att-3' }]);
  });

  it('carries no field the shape does not name', () => {
    const [image] = asImages([
      { name: 'a.png', mime: 'image/png', ref: 'att-1', data: 'AAAA', prompt: 'ignore this' },
    ]);
    expect(Object.keys(image ?? {}).sort()).toEqual(['mime', 'name', 'ref']);
  });
});

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    seq: 0,
    externalId: null,
    role: 'assistant' as const,
    authorUserId: null,
    authorLabel: null,
    authorKey: null,
    content: 'You have two.',
    blocks: null,
    images: [],
    deliveryProof: null,
    silenceReason: null,
    createdAt: new Date(1_700_000_000_000),
    ...over,
  } as Parameters<typeof toCanonicalEntry>[0];
}

describe('asBlocks', () => {
  it('reads the blocks a turn wrote', () => {
    expect(asBlocks([{ type: 'text', text: 'hi' }])).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('answers null for a column that is not an array of blocks', () => {
    for (const v of [null, undefined, {}, 'text', 3, true, []]) expect(asBlocks(v)).toBeNull();
  });

  // cm:guard this whitelist is the ONLY thing standing between a stored block and a reader, and it
  // is not a compile-time list: it takes `unknown` and filters, so widening `ContentBlock` does not
  // widen it. A member added to the shape and not here is dropped on the way out of the database
  // with nothing on either side saying so — which is what happened to `thinking` for the length of
  // one plan consult (ISS-1079, plan consult F1).
  it('reads a thinking block back with its text and its duration', () => {
    expect(asBlocks([{ type: 'thinking', thinking: 'let me check', durationMs: 400 }])).toEqual([
      { type: 'thinking', thinking: 'let me check', durationMs: 400 },
    ]);
  });

  // cm:guard a thinking block with NO text is the encrypted pause, and it must come back as one
  // rather than be filtered out for holding nothing: `out.length > 0` is the only emptiness test
  // here, and a block is not empty because it carries no text (ISS-1079, whole-set read F1).
  it('reads back an encrypted pause, which is a thinking block with no text', () => {
    expect(asBlocks([{ type: 'thinking' }, { type: 'text', text: 'ok' }])).toEqual([
      { type: 'thinking' },
      { type: 'text', text: 'ok' },
    ]);
  });

  it('keeps a thinking block in order beside the prose and the tools it sat between', () => {
    const stored = [
      { type: 'thinking', thinking: 'hmm', durationMs: 120 },
      { type: 'text', text: 'Let me look.' },
      { type: 'tool', toolCall: { id: 't1', name: 'forge_issues', input: {} } },
      { type: 'text', text: 'Two left.' },
    ];
    expect(asBlocks(stored)?.map((b) => b.type)).toEqual(['thinking', 'text', 'tool', 'text']);
  });

  // cm:guard an illegible column degrades to the LEGACY reading, not to an empty turn: null is what
  // `toCanonicalEntry` answers from `content`, and `[]` would render a real answer as nothing.
  it('drops entries it cannot read and answers null when none survive', () => {
    expect(asBlocks([{ type: 'nonsense' }, 7, null])).toBeNull();
    expect(asBlocks([{ type: 'nonsense' }, { type: 'text', text: 'kept' }])).toEqual([
      { type: 'text', text: 'kept' },
    ]);
  });
});

describe('toCanonicalEntry', () => {
  it('reads an assistant row as an assistant entry', () => {
    const e = toCanonicalEntry(row());
    expect(e.type).toBe('assistant');
    expect(e.id).toBe('row-1');
    expect(e.timestamp).toBe(1_700_000_000_000);
  });

  it('reads a user row and a system row as their own kinds', () => {
    expect(toCanonicalEntry(row({ role: 'user' })).type).toBe('user');
    expect(toCanonicalEntry(row({ role: 'system' })).type).toBe('system');
  });

  // cm:guard this is the whole of the back-compatibility promise: every row written before
  // ISS-1029 carries its answer in `content` and no blocks, and it has to read back as something
  // the one formatter renders rather than as a turn nobody answered.
  it('reads a legacy row with no blocks as a single text block', () => {
    expect(toCanonicalEntry(row()).blocks).toEqual([{ type: 'text', text: 'You have two.' }]);
  });

  it('gives a row with neither text nor blocks no blocks at all', () => {
    const e = toCanonicalEntry(row({ content: '', silenceReason: 'error' }));
    expect(e.blocks).toBeUndefined();
    expect(e.content).toBeUndefined();
  });

  it('collects the tool calls out of the blocks it was given', () => {
    const blocks = [
      { type: 'text' as const, text: 'Let me look.' },
      {
        type: 'tool' as const,
        toolCall: { id: 'c1', name: 'forge_issues', output: 'two', isError: true, durationMs: 9 },
      },
    ];
    const e = toCanonicalEntry(row({ blocks }));
    expect(e.blocks).toEqual(blocks);
    expect(e.toolCalls).toEqual([blocks[1]?.toolCall]);
  });
});
