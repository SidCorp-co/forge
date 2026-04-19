import { searchSimilar, searchBM25 } from './index';
import type { SearchResult, MetadataFilter } from './index';
import { searchByEntities, extractEntities } from '../entity-index';

/** Standard RRF constant — higher values favour top-ranked results less aggressively */
const RRF_K = 60;

/** Default weight for dense vector search vs BM25 (0–1). Higher = more vector weight. */
const DEFAULT_ALPHA = 0.7;

/**
 * Run search strategies in parallel: entity index, dense vector, BM25 sparse.
 * Merge via Reciprocal Rank Fusion (RRF) and return unified ranked list.
 */
export async function multiStrategySearch(
  strapi: any,
  projectId: string,
  query: string,
  topK = 20,
  sourceTypes?: string[],
  metadataFilters?: MetadataFilter[],
  alpha?: number,
): Promise<{ results: SearchResult[]; breakdown: { entity: number; vector: number; bm25: number } }> {
  const keywords = extractEntities(query).slice(0, 10);
  const a = alpha ?? DEFAULT_ALPHA;

  const [entityResultsRaw, vectorResults, bm25Results] = await Promise.all([
    searchByEntities(projectId, keywords).catch((err) => {
      strapi.log.warn(`[multi-search] entity search failed: ${err}`);
      return [] as SearchResult[];
    }),
    searchSimilar(projectId, query, topK, sourceTypes, metadataFilters).catch((err) => {
      strapi.log.warn(`[multi-search] vector search failed: ${err}`);
      return [] as SearchResult[];
    }),
    searchBM25(projectId, query, topK, sourceTypes, metadataFilters).catch((err) => {
      strapi.log.warn(`[multi-search] BM25 search failed: ${err}`);
      return [] as SearchResult[];
    }),
  ]);

  // Apply sourceTypes filter to entity results (Qdrant entity search doesn't filter by source_type)
  const entityResults = sourceTypes?.length
    ? entityResultsRaw.filter((r) => sourceTypes.includes(r.payload.source_type))
    : entityResultsRaw;

  // RRF with weighted strategies: entity (1.0), vector (alpha), BM25 (1-alpha)
  const merged = reciprocalRankFusion(
    [entityResults, vectorResults, bm25Results],
    [1.0, a, 1 - a],
    topK,
  );

  strapi.log.info(
    `[multi-search] query="${query.slice(0, 60)}" entity:${entityResults.length} vector:${vectorResults.length} bm25:${bm25Results.length} → merged:${merged.length}`,
  );

  return {
    results: merged,
    breakdown: {
      entity: entityResults.length,
      vector: vectorResults.length,
      bm25: bm25Results.length,
    },
  };
}

/**
 * Reciprocal Rank Fusion — merge multiple ranked lists into one.
 *
 * For each result across all lists:
 *   score = Σ weight_i / (k + rank_i)
 * where rank_i is the 1-based position in list i.
 *
 * Results appearing in multiple lists accumulate higher RRF scores.
 */
function reciprocalRankFusion(
  rankedLists: SearchResult[][],
  weights: number[],
  limit: number,
  k = RRF_K,
): SearchResult[] {
  const scoreMap = new Map<string, { score: number; result: SearchResult }>();

  for (let listIdx = 0; listIdx < rankedLists.length; listIdx++) {
    const list = rankedLists[listIdx];
    const weight = weights[listIdx] ?? 1.0;

    for (let rank = 0; rank < list.length; rank++) {
      const result = list[rank];
      const key = `${result.payload.source_type}:${result.payload.source_id}:${result.payload.chunk_index}`;
      const rrfScore = weight / (k + rank + 1); // rank is 0-based, RRF uses 1-based

      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(key, { score: rrfScore, result });
      }
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, result }) => ({ ...result, score }));
}
