/**
 * Unified retrieval strategy router for agentic RAG.
 * Maps strategy names to retrieval pipelines, applies cross-encoder reranking,
 * and tracks analytics per invocation.
 */

import { searchSimilar, searchBM25 } from '../embeddings';
import type { SearchResult, MetadataFilter } from '../embeddings';
import { multiStrategySearch } from '../embeddings/multi-search';
import { crossEncoderRerank } from '../embeddings/cross-encoder';
import { searchByEntities, extractEntities } from '../entity-index';
import { findMemoriesByGraph } from '../knowledge-graph';
import { ragGate } from '../rag-gate';
import type { QueryIntent } from '../rag-gate';
import { trackStrategyUsage } from './strategy-analytics';
import type { RetrievalStrategy } from './strategy-analytics';

export type { RetrievalStrategy };

export interface StrategyOptions {
  limit?: number;
  sourceTypes?: string[];
  metadataFilters?: MetadataFilter[];
}

interface StrategyResult {
  results: SearchResult[];
  resolvedStrategy?: string;
}

/**
 * Execute a retrieval strategy and return results with cross-encoder reranking.
 * Tracks analytics fire-and-forget.
 */
export async function executeStrategy(
  strapi: any,
  projectId: string,
  query: string,
  strategy: RetrievalStrategy,
  options?: StrategyOptions,
): Promise<StrategyResult> {
  const limit = options?.limit || 10;
  const sourceTypes = options?.sourceTypes || ['memory'];
  const metadataFilters = options?.metadataFilters;
  const start = Date.now();

  let results: SearchResult[];
  let resolvedStrategy: string | undefined;

  switch (strategy) {
    case 'semantic':
      results = await runSemantic(projectId, query, limit, sourceTypes, metadataFilters);
      break;

    case 'keyword':
      results = await runKeyword(projectId, query, limit, sourceTypes, metadataFilters);
      break;

    case 'graph':
      results = await runGraph(strapi, projectId, query, limit);
      break;

    case 'hybrid':
      results = await runHybrid(strapi, projectId, query, limit, sourceTypes, metadataFilters);
      break;

    case 'auto': {
      const resolved = await runAuto(strapi, projectId, query, limit, sourceTypes, metadataFilters);
      results = resolved.results;
      resolvedStrategy = resolved.resolvedStrategy;
      break;
    }

    default:
      results = await runHybrid(strapi, projectId, query, limit, sourceTypes, metadataFilters);
  }

  // Cross-encoder reranking (if enabled)
  const ceResults = await crossEncoderRerank(query, results, limit);
  if (ceResults) {
    results = ceResults;
  }

  const latencyMs = Date.now() - start;
  const topScore = results.length > 0 ? results[0].score : 0;

  // Fire-and-forget analytics
  trackStrategyUsage(strapi, projectId, strategy, query, results.length, topScore, latencyMs, resolvedStrategy);

  return { results: results.slice(0, limit), resolvedStrategy };
}

// --- Individual strategy implementations ---

async function runSemantic(
  projectId: string,
  query: string,
  limit: number,
  sourceTypes?: string[],
  metadataFilters?: MetadataFilter[],
): Promise<SearchResult[]> {
  return searchSimilar(projectId, query, limit, sourceTypes, metadataFilters);
}

async function runKeyword(
  projectId: string,
  query: string,
  limit: number,
  sourceTypes?: string[],
  metadataFilters?: MetadataFilter[],
): Promise<SearchResult[]> {
  const keywords = extractEntities(query).slice(0, 10);

  const [bm25Results, entityResults] = await Promise.all([
    searchBM25(projectId, query, limit, sourceTypes, metadataFilters).catch(() => [] as SearchResult[]),
    searchByEntities(projectId, keywords).catch(() => [] as SearchResult[]),
  ]);

  // Filter entity results by sourceTypes
  const filteredEntity = sourceTypes?.length
    ? entityResults.filter((r) => sourceTypes.includes(r.payload.source_type))
    : entityResults;

  // If BM25 returns empty (no sparse vectors backfilled), fall back to
  // Qdrant scroll with entity keyword filter for keyword-style retrieval
  let fallbackResults: SearchResult[] = [];
  if (bm25Results.length === 0 && keywords.length > 0) {
    fallbackResults = await scrollByKeywords(projectId, keywords, limit, sourceTypes);
  }

  // Merge by highest score per source
  const byKey = new Map<string, SearchResult>();
  for (const r of [...bm25Results, ...filteredEntity, ...fallbackResults]) {
    const key = `${r.payload.source_type}:${r.payload.source_id}:${r.payload.chunk_index}`;
    const existing = byKey.get(key);
    if (!existing || r.score > existing.score) {
      byKey.set(key, r);
    }
  }

  return Array.from(byKey.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Fallback keyword search: scroll Qdrant for points whose text contains keywords.
 * Used when BM25 sparse vectors haven't been backfilled yet.
 */
async function scrollByKeywords(
  projectId: string,
  keywords: string[],
  limit: number,
  sourceTypes?: string[],
): Promise<SearchResult[]> {
  const { getQdrantClient } = await import('../embeddings/qdrant');
  const qdrant = getQdrantClient();
  if (!qdrant) return [];

  try {
    const must: Record<string, any>[] = [
      { key: 'project_id', match: { value: projectId } },
    ];
    if (sourceTypes?.length) {
      must.push({ key: 'source_type', match: { any: sourceTypes } });
    }
    // Match any of the extracted keywords in the entities payload field
    must.push({ key: 'entities', match: { any: keywords } });

    const result = await qdrant.scroll('forge_embeddings', {
      filter: { must },
      limit,
      with_payload: true,
      with_vector: false,
    });

    return (result.points || []).map((point) => {
      const payload = point.payload as any;
      // Score by keyword overlap ratio
      const pointEntities = (payload.entities || []) as string[];
      const overlap = keywords.filter((k) => pointEntities.includes(k)).length;
      const score = 0.50 + Math.min(0.40, (overlap / keywords.length) * 0.40);
      return {
        score,
        payload: {
          source_type: payload.source_type || '',
          source_id: payload.source_id || '',
          text: payload.text || '',
          project_id: payload.project_id || projectId,
          chunk_index: payload.chunk_index || 0,
          metadata: payload.metadata || {},
          entities: payload.entities || [],
        },
      };
    });
  } catch {
    return [];
  }
}

async function runGraph(
  strapi: any,
  projectId: string,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  return findMemoriesByGraph(strapi, projectId, query, limit);
}

async function runHybrid(
  strapi: any,
  projectId: string,
  query: string,
  limit: number,
  sourceTypes?: string[],
  metadataFilters?: MetadataFilter[],
): Promise<SearchResult[]> {
  const { results } = await multiStrategySearch(strapi, projectId, query, limit, sourceTypes, metadataFilters);
  return results;
}

/** Intent → strategy mapping */
const INTENT_STRATEGY_MAP: Record<QueryIntent, RetrievalStrategy> = {
  SEARCH: 'semantic',
  LOOKUP: 'keyword',
  SUMMARY: 'hybrid',
  CREATE: 'hybrid',
  ACTION: 'hybrid',
  CHAT: 'semantic',
};

async function runAuto(
  strapi: any,
  projectId: string,
  query: string,
  limit: number,
  sourceTypes?: string[],
  metadataFilters?: MetadataFilter[],
): Promise<{ results: SearchResult[]; resolvedStrategy: string }> {
  const { intent } = await ragGate(strapi, query, []);
  const resolved = INTENT_STRATEGY_MAP[intent] || 'hybrid';

  let results: SearchResult[];
  switch (resolved) {
    case 'semantic':
      results = await runSemantic(projectId, query, limit, sourceTypes, metadataFilters);
      break;
    case 'keyword':
      results = await runKeyword(projectId, query, limit, sourceTypes, metadataFilters);
      break;
    case 'hybrid':
      results = await runHybrid(strapi, projectId, query, limit, sourceTypes, metadataFilters);
      break;
    default:
      results = await runHybrid(strapi, projectId, query, limit, sourceTypes, metadataFilters);
  }

  return { results, resolvedStrategy: resolved };
}
