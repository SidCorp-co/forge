// A stored message's blocks are read back whole: a block this build does not know is kept and named,
// never skipped, because a skipped block is an answer part that vanishes without a word.

import { describe, expect, it } from 'vitest';
import { asBlocks } from './canonical-entry.js';

describe('asBlocks', () => {
  it('keeps the kinds it knows as they were stored, a visual block among them', () => {
    const visual = { type: 'visual', visual: { v: 1, kind: 'table' } };
    const text = { type: 'text', text: 'hello' };
    expect(asBlocks([text, visual])).toEqual([text, visual]);
  });

  it('keeps a block of a type it does not know, naming the type', () => {
    const out = asBlocks([
      { type: 'text', text: 'a' },
      { type: 'hologram', payload: 1 },
    ]);
    expect(out).toEqual([
      { type: 'text', text: 'a' },
      { type: 'unsupported', unsupported: 'hologram' },
    ]);
  });

  it('keeps an entry that is no block at all, naming what it was', () => {
    expect(asBlocks([null, 7, 'x', [], {}, { type: 3 }])).toEqual([
      { type: 'unsupported', unsupported: 'null' },
      { type: 'unsupported', unsupported: 'number' },
      { type: 'unsupported', unsupported: 'string' },
      { type: 'unsupported', unsupported: 'array' },
      { type: 'unsupported', unsupported: '(no type)' },
      { type: 'unsupported', unsupported: '(no type)' },
    ]);
  });

  it('names a block that is already an unsupported marker by its own name, not as unsupported', () => {
    expect(asBlocks([{ type: 'unsupported', unsupported: 'hologram' }])).toEqual([
      { type: 'unsupported', unsupported: 'hologram' },
    ]);
  });

  it('reads a column that is no list, or an empty one, as nothing', () => {
    expect(asBlocks(null)).toBeNull();
    expect(asBlocks({})).toBeNull();
    expect(asBlocks([])).toBeNull();
  });
});
