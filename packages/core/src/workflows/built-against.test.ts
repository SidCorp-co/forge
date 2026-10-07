import { describe, expect, it } from 'vitest';
import { builtAgainstOf } from './design-standing.js';

const at = (iso: string) => new Date(iso);
const designs = [
  { revision: 4, decision: null, decidedAt: null },
  { revision: 3, decision: 'approve', decidedAt: at('2026-10-05T00:00:00Z') },
  { revision: 2, decision: 'return', decidedAt: at('2026-10-03T00:00:00Z') },
  { revision: 1, decision: 'approve', decidedAt: at('2026-10-01T00:00:00Z') },
];

describe('the revision a build was linked against (R-22)', () => {
  it('is the newest approval decided at or before the link', () => {
    expect(builtAgainstOf(at('2026-10-04T00:00:00Z'), designs)).toBe(1);
    expect(builtAgainstOf(at('2026-10-05T00:00:00Z'), designs)).toBe(3);
    expect(builtAgainstOf(at('2026-10-09T00:00:00Z'), designs)).toBe(3);
  });

  it('is none where nothing was approved when it was linked; a return or a proposal is no approval', () => {
    expect(builtAgainstOf(at('2026-09-30T00:00:00Z'), designs)).toBeNull();
    expect(builtAgainstOf(at('2026-10-09T00:00:00Z'), designs.slice(0, 1))).toBeNull();
  });
});
