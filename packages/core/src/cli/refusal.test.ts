import { describe, expect, it } from 'vitest';
import { duplicateRefusal, shapeRefusal } from './refusal.js';
import type { FilingGap } from './shape.js';

const GAP: FilingGap = {
  read: 'what was read',
  wants: 'what the shape wants',
  clear: 'the way out',
};

describe('the refusal a filer meets', () => {
  it('carries all three parts of every gap, one line each', () => {
    const text = shapeRefusal([GAP, { ...GAP, read: 'a second gap' }]);
    expect(text).toContain(
      '- read: what was read\n  wants: what the shape wants\n  clear: the way out',
    );
    expect(text).toContain('a second gap');
  });

  it('opens by saying the filing was held rather than filed', () => {
    expect(shapeRefusal([GAP]).split('\n')[0]).toContain('Hold');
  });
});

describe('the refusal for a matched near-duplicate', () => {
  const text = duplicateRefusal({ id: 'uuid-1', issSeq: 61, title: 'the open one' });

  it('names the matched issue by its key', () => {
    expect(text).toContain('ISS-61');
  });

  it('offers the comment on that issue as the way out', () => {
    expect(text).toContain('comment on ISS-61');
  });
});
