const MIN_TOP_K = 1;
const MAX_TOP_K = 50;

export function clampTopK(topK: number | undefined): number {
  return Math.min(Math.max(topK ?? 10, MIN_TOP_K), MAX_TOP_K);
}

/** Standard RRF constant — higher k flattens the advantage of top ranks. */
const RRF_K = 60;
/** Dense-vector weight in hybrid fusion (keyword gets `1 - alpha`). */
const HYBRID_ALPHA = 0.5;

/**
 * The cosine similarity a dense hit must reach to count as a match in the find door; under it a hit
 * is only the nearest of what is there, and a find holding nothing else is a gap. A dense arm always
 * answers its nearest rows, and the embedding model sets every text near half-similar to every other:
 * measured on forge-dev (2026-11-16, knowledge recall), fourteen nonsense or off-topic queries
 * ("zzqx flarn vobble", "qzxv wbrlt", "xyzzy", "the quick brown fox jumps", a Vietnamese sentence
 * about a cat) topped out between 0.43 and 0.544, while queries naming what the project holds led at
 * 0.584 to 0.666 and a thin real match ("run slots" → a lesson on waiting for a slot) sat at 0.557.
 * 0.55 is the line between them; the 0.3 it replaces passed every nonsense query.
 */
export const SEMANTIC_FLOOR = 0.55;

/**
 * The floor of the find door's memory-backed arm (memory's semantic read: core's copies of the
 * issues, and memory's notes, decisions and knowledge copies), where `SEMANTIC_FLOOR` is the
 * knowledge arm's. Short issues, such as dropped "[judge K80 test] throwaway" ones, embed
 * near any token soup: measured on forge-dev after dev.700 (2026-11-17, memory semantic read over
 * issues), nonsense led at 0.561 ("zzqx flarn vobble"), 0.553 ("qzxv wbrlt"), 0.55 ("lorem ipsum
 * dolor"), 0.523 and 0.487, while narrow real queries led at 0.62 ("run slots") to 0.735 ("the
 * release waits for an approval"). 0.59 is the line between them. A knowledge copy under it is still
 * found by the knowledge arm, whose thinnest real match sits at 0.557. Memory's own search route
 * takes no floor from here.
 */
export const ISSUE_SEMANTIC_FLOOR = 0.59;

/**
 * The floor of the find door's item arms (requirements and feedback, over `item_embeddings`). A
 * short item embeds near token soup like a short issue does: measured on forge-dev at d369cb8b
 * (2026-11-17, feedback similar's top cosines), nonsense led at 0.562 ("lorem ipsum dolor"), 0.552
 * ("zzqx flarn vobble", which answered FB-289 and FB-197), 0.543 ("asdf qwer zxcv") and 0.54
 * ("qzxv wbrlt"), while real paraphrases led at 0.638 ("proposal card shows no summary") to 0.735
 * ("owner chat account not linked"). 0.6 is the line between them. Narrow literal queries ("run
 * slots" 0.575, "module map pillar" 0.57) sit inside the noise and are left under it on purpose: the
 * keyword arm finds a requirement by its title and a feedback item by its title or body when their
 * words are there.
 */
export const ITEM_SEMANTIC_FLOOR = 0.6;

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
