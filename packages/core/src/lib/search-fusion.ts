const MIN_TOP_K = 1;
const MAX_TOP_K = 50;

export function clampTopK(topK: number | undefined): number {
  return Math.min(Math.max(topK ?? 10, MIN_TOP_K), MAX_TOP_K);
}

/** Standard RRF constant — higher k flattens the advantage of top ranks. */
const RRF_K = 60;
/** Dense-vector weight in hybrid fusion (keyword gets `1 - alpha`). */
const HYBRID_ALPHA = 0.5;

/** One ranked list a fusion takes, and its weight. */
export interface RankedList<T> {
  hits: readonly T[];
  weight: number;
}

/**
 * Weighted reciprocal-rank fusion of any number of ranked lists: each hit scores
 * `weight / (RRF_K + rank)` in each list it is in, summed. Scores of different kinds (a cosine, a
 * ts_rank) are never compared, only ranks. The first list a hit appears in gives the object kept.
 */
export function fuseRanked<T extends { id: string; score: number }>(
  lists: readonly RankedList<T>[],
  limit: number,
): T[] {
  const scoreMap = new Map<string, { score: number; hit: T }>();
  for (const { hits, weight } of lists) {
    hits.forEach((hit, rank) => {
      const rrfScore = weight / (RRF_K + rank + 1); // rank is 0-based, RRF uses 1-based
      const existing = scoreMap.get(hit.id);
      if (existing) existing.score += rrfScore;
      else scoreMap.set(hit.id, { score: rrfScore, hit });
    });
  }
  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, hit }) => ({ ...hit, score }));
}

/** The weights a keyword and a dense arm take in every hybrid fusion. */
export const HYBRID_WEIGHTS = { semantic: HYBRID_ALPHA, keyword: 1 - HYBRID_ALPHA } as const;

/**
 * Weighted reciprocal-rank fusion of a dense and a keyword list, the one fusion memory and the find
 * door share. The returned `score` is the fused RRF value.
 */
export function fuseHybrid<T extends { id: string; score: number }>(
  semantic: T[],
  keyword: T[],
  limit: number,
): T[] {
  return fuseRanked(
    [
      { hits: semantic, weight: HYBRID_WEIGHTS.semantic },
      { hits: keyword, weight: HYBRID_WEIGHTS.keyword },
    ],
    limit,
  );
}
