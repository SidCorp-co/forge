import { describe, expect, it } from 'vitest';
import {
  DUE_PROBE_LIMIT,
  FRESH_SIGHTING_LIMIT,
  pendingSightingLimit,
  RELEASED_PER_PASS,
  withOwed,
} from './owed-sighting.js';

const row = (id: string, from: string) => ({ id, from });

describe('the rows a paged sweep reads in one pass (ISS-1229 r12)', () => {
  it('keeps the page first and adds each owed row once', () => {
    const page = [row('a', 'page'), row('b', 'page')];
    const pending = [row('b', 'pending'), row('c', 'pending')];
    const fresh = [row('c', 'fresh'), row('d', 'fresh')];

    expect(withOwed(page, pending, fresh)).toEqual([
      row('a', 'page'),
      row('b', 'page'),
      row('c', 'pending'),
      row('d', 'fresh'),
    ]);
  });

  it('reads the owed rows alone when the page is empty', () => {
    expect(withOwed([], [row('x', 'pending')]).map((r) => r.id)).toEqual(['x']);
  });

  it('re-sights every condition three passes can have left pending', () => {
    expect(pendingSightingLimit(200)).toBe(
      3 * (200 + FRESH_SIGHTING_LIMIT + DUE_PROBE_LIMIT + RELEASED_PER_PASS),
    );
  });
});
