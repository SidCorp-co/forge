import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../embeddings/index.js', () => ({ embed: vi.fn() }));

const { rrfFuse, HYBRID_ALPHA } = await import('./search.js');
type KnowledgeHit = import('./search.js').KnowledgeHit;

const hit = (id: string, score: number): KnowledgeHit =>
  ({
    id,
    slug: id,
    kind: 'convention',
    title: id,
    body: id,
    injection: 'on_demand',
    confidence: 'inferred',
    score,
  }) as unknown as KnowledgeHit;
const semanticOf = (n: number) =>
  Array.from({ length: n }, (_, i) => hit(`s${i + 1}`, 1 - i / 100));

describe('knowledge hybrid fusion keeps a keyword-only hit (ISS-907)', () => {
  const weights = [HYBRID_ALPHA, 1 - HYBRID_ALPHA];

  it('a keyword-only rank 1 is inside the fused top 8 when the semantic arm returns 8 others', () => {
    expect(rrfFuse([semanticOf(8), [hit('k1', 0.9)]], weights, 8).map((h) => h.id)).toContain('k1');
  });

  it('and inside a pool of 24 when it returns 24', () => {
    expect(rrfFuse([semanticOf(24), [hit('k1', 0.9)]], weights, 24).map((h) => h.id)).toContain(
      'k1',
    );
  });

  it('at 0.7/0.3 the same hit was cut', () => {
    expect(
      rrfFuse([semanticOf(8), [hit('k1', 0.9)]], [0.7, 0.3], 8).map((h) => h.id),
    ).not.toContain('k1');
  });

  it('a hit found by both arms still ranks first', () => {
    const fused = rrfFuse([semanticOf(3), [hit('s2', 0.5)]], weights, 3);
    expect(fused[0]?.id).toBe('s2');
  });
});
