import { describe, expect, it, vi } from 'vitest';

// search.ts pulls in the db client, whose env validation throws without a
// DATABASE_URL; the RRF tests are pure and never touch it.
vi.mock('../db/client.js', () => ({ db: {} }));

const { reciprocalRankFusion } = await import('./search.js');
type MemoryHit = import('./search.js').MemoryHit;

function hit(id: string, score: number): MemoryHit {
  return {
    id,
    source: 'note',
    sourceRef: `ref-${id}`,
    text: `text ${id}`,
    metadata: {},
    score,
    embeddedAt: new Date('2026-01-01'),
  };
}

describe('reciprocalRankFusion', () => {
  it('ranks a hit found by both strategies above single-strategy hits', () => {
    const semantic = [hit('a', 0.9), hit('b', 0.8), hit('c', 0.7)];
    const keyword = [hit('d', 0.5), hit('b', 0.4)];

    const fused = reciprocalRankFusion([semantic, keyword], [0.7, 0.3], 10);

    // b: 0.7/(60+2) + 0.3/(60+2) = 1.0/62 — beats a's 0.7/61.
    expect(fused[0]?.id).toBe('b');
    expect(fused.map((h) => h.id)).toContain('a');
    expect(fused.map((h) => h.id)).toContain('d');
  });

  it('weights strategies — heavier list dominates equal ranks', () => {
    const semantic = [hit('a', 0.9)];
    const keyword = [hit('b', 0.9)];
    const fused = reciprocalRankFusion([semantic, keyword], [0.7, 0.3], 10);
    expect(fused[0]?.id).toBe('a');
    expect(fused[1]?.id).toBe('b');
  });

  it('respects the limit', () => {
    const semantic = [hit('a', 1), hit('b', 1), hit('c', 1)];
    const fused = reciprocalRankFusion([semantic], [1], 2);
    expect(fused).toHaveLength(2);
  });

  it('replaces per-strategy scores with the fused RRF score', () => {
    const fused = reciprocalRankFusion([[hit('a', 0.93)]], [1], 10);
    expect(fused[0]?.score).toBeCloseTo(1 / 61, 6);
  });

  it('handles empty lists', () => {
    expect(reciprocalRankFusion([[], []], [0.7, 0.3], 5)).toEqual([]);
  });
});
