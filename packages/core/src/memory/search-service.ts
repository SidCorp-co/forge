import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { type MemorySource, retrievalAnalytics } from '../db/schema.js';
import { EmbeddingUnavailableError, embedQuery } from '../embeddings/index.js';
import { logger } from '../logger.js';
import { expandIssueRelations } from './expand-relations.js';
import { fastModelConfigured } from './llm.js';
import { inRerankHoldout, rerankHits, rerankPoolSize } from './rerank.js';
import { loadRetrievalFlags, type RetrievalFlags } from './retrieval-flags.js';
import {
  clampTopK,
  type HybridBreakdown,
  hybridSearchMemories,
  keywordSearchMemories,
  type MemoryHit,
  searchMemories,
  touchMemories,
} from './search.js';

/**
 * Run a memory search. Shared between the `POST /api/memory/search` REST
 * route and the `forge_memory.search` MCP tool (ISS-202) so both surfaces
 * return the exact same shape.
 *
 * Strategies (memory-v2 phase 1):
 *  - `semantic` (default) — cosine over embeddings. Scores are similarity
 *    (≈0..1); existing consumers threshold on these (knowledge dedup fact
 *    uses > 0.8), which is why the default did NOT change to hybrid.
 *  - `keyword`  — Postgres FTS. No embedding call; exact-identifier recall.
 *  - `hybrid`   — both in parallel, weighted RRF fusion. Degrades to
 *    keyword-only when the embeddings service is down (`degraded: true`).
 *
 * Does NOT check authorization — callers must verify project membership
 * before invoking this function.
 */

export const memorySearchStrategies = ['semantic', 'keyword', 'hybrid'] as const;
export type MemorySearchStrategy = (typeof memorySearchStrategies)[number];

export const memorySearchSurfaces = ['agent', 'web'] as const;
export type MemorySearchSurface = (typeof memorySearchSurfaces)[number];

export interface RunMemorySearchInput {
  projectId: string;
  query: string;
  topK?: number | undefined;
  sourceFilter?: MemorySource[] | undefined;
  strategy?: MemorySearchStrategy | undefined;
  surface: MemorySearchSurface;
  /**
   * The query already embedded by the caller. `knowledge/unified-search.ts` holds one because it
   * searches two stores from one query, and embedding it a second time here buys nothing but the
   * call. Absent, this function embeds the query itself as it always did.
   */
  queryVec?: number[] | undefined;
}

export interface MemorySearchResult {
  hits: MemoryHit[];
  model: string;
  took_ms: number;
  /** What the query's embedding took, over every attempt; absent when none was made here (a keyword search, or a vector the caller supplied). */
  embedMs?: number;
  /** Strategy actually executed — differs from the request when degraded. */
  strategy: MemorySearchStrategy;
  /** True when hybrid fell back to keyword because embeddings were down. */
  degraded?: boolean;
  /** True when the fast model ordered the hits; read them by position, `score` is still the RRF value. */
  reranked: boolean;
  /** Present only on an eligible search that was deliberately left in RRF order as the pilot's control. */
  rerankHoldout?: true;
  /** True when rows carrying `via` were appended after the ranked hits. */
  expanded: boolean;
  /** How many retrieved hits were moved below the fresh ones because they carry `staleSince`. Absent when none were. */
  demotedStale?: number;
}

/** What one search did beyond retrieving — the fields both the response and the analytics row carry. */
interface SearchOutcome {
  reranked: boolean;
  rerankMs?: number;
  rerankHoldout?: true;
  expanded: boolean;
  expandedCount?: number;
  demotedStale?: number;
}

function demoteStale(hits: MemoryHit[]): { hits: MemoryHit[]; demoted: number } {
  const fresh = hits.filter((h) => !h.stale);
  if (fresh.length === hits.length) return { hits, demoted: 0 };
  const stale = hits.filter((h) => h.stale);
  return { hits: [...fresh, ...stale], demoted: stale.length };
}

function rerankEligible(input: RunMemorySearchInput, flags: RetrievalFlags): boolean {
  return (
    input.strategy === 'hybrid' &&
    input.surface === 'agent' &&
    flags.rerank &&
    fastModelConfigured()
  );
}

async function retrieve(
  input: RunMemorySearchInput,
  poolTopK: number,
  flags: RetrievalFlags,
): Promise<{
  hits: MemoryHit[];
  resolved: MemorySearchStrategy;
  degraded: boolean;
  breakdown?: HybridBreakdown;
  embedMs?: number;
}> {
  const requested: MemorySearchStrategy = input.strategy ?? 'semantic';
  const base = {
    projectId: input.projectId,
    topK: input.topK,
    sourceFilter: input.sourceFilter,
    memoryModel: flags.memoryModel,
  };
  if (requested === 'keyword') {
    const hits = await keywordSearchMemories({ ...base, query: input.query });
    return { hits, resolved: requested, degraded: false };
  }
  const embedStarted = Date.now();
  const attempted = input.queryVec === undefined;
  const embedMsNow = () => (attempted ? { embedMs: Date.now() - embedStarted } : {});
  try {
    const queryVec = input.queryVec ?? (await embedQuery(input.query));
    const embedMs = embedMsNow();
    if (requested === 'hybrid') {
      const fused = await hybridSearchMemories({
        ...base,
        topK: poolTopK,
        queryVec,
        query: input.query,
      });
      return {
        hits: fused.hits,
        resolved: requested,
        degraded: false,
        breakdown: fused.breakdown,
        ...embedMs,
      };
    }
    return {
      hits: await searchMemories({ ...base, queryVec }),
      resolved: requested,
      degraded: false,
      ...embedMs,
    };
  } catch (err) {
    if (!(err instanceof EmbeddingUnavailableError) || requested !== 'hybrid') throw err;
    const embedMs = embedMsNow();
    logger.warn(
      { projectId: input.projectId, err: (err as Error).message, ...embedMs },
      'memory.search: embeddings unavailable, hybrid degraded to keyword',
    );
    const hits = await keywordSearchMemories({ ...base, query: input.query });
    return { hits, resolved: 'keyword', degraded: true, ...embedMs };
  }
}

async function expand(
  input: RunMemorySearchInput,
  hits: MemoryHit[],
  topK: number,
): Promise<MemoryHit[]> {
  try {
    return await expandIssueRelations({ projectId: input.projectId, hits, topK });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, projectId: input.projectId },
      'memory.search: relation expansion failed, returning ranked hits only',
    );
    return [];
  }
}

export async function runMemorySearch(input: RunMemorySearchInput): Promise<MemorySearchResult> {
  const startedAt = Date.now();
  const requested: MemorySearchStrategy = input.strategy ?? 'semantic';
  const topK = clampTopK(input.topK);
  const flags = await loadRetrievalFlags(input.projectId);
  const eligible = rerankEligible(input, flags);
  const holdout = eligible && inRerankHoldout();
  const willRerank = eligible && !holdout;

  const retrieved = await retrieve(input, willRerank ? rerankPoolSize(topK) : topK, flags);
  let hits = retrieved.hits;
  const outcome: SearchOutcome = { reranked: false, expanded: false };
  if (holdout) outcome.rerankHoldout = true;

  if (willRerank && retrieved.resolved === 'hybrid') {
    const result = await rerankHits({ query: input.query, hits, topK });
    hits = result.hits;
    outcome.reranked = result.reranked;
    outcome.rerankMs = result.rerankMs;
  } else if (hits.length > topK) {
    hits = hits.slice(0, topK);
  }

  const demotion = demoteStale(hits);
  hits = demotion.hits;
  if (demotion.demoted > 0) outcome.demotedStale = demotion.demoted;

  if (flags.expandRelations && hits.length > 0) {
    const appended = await expand(input, hits, topK);
    if (appended.length > 0) {
      hits = [...hits, ...appended];
      outcome.expanded = true;
      outcome.expandedCount = appended.length;
    }
  }

  const tookMs = Date.now() - startedAt;
  logRetrieval(input, hits, retrieved.resolved, requested, tookMs, retrieved.breakdown, outcome);

  if (hits.length > 0) {
    const hitIds = hits.map((h) => h.id);
    queueMicrotask(() => {
      touchMemories(hitIds).catch((err) => {
        logger.warn(
          { err: (err as Error).message, projectId: input.projectId },
          'memory.search: usage tracking failed',
        );
      });
    });
  }

  return {
    hits,
    model: env.EMBEDDINGS_MODEL,
    took_ms: tookMs,
    ...(retrieved.embedMs !== undefined ? { embedMs: retrieved.embedMs } : {}),
    strategy: retrieved.resolved,
    ...(retrieved.degraded ? { degraded: true } : {}),
    reranked: outcome.reranked,
    ...(outcome.rerankHoldout ? { rerankHoldout: true as const } : {}),
    expanded: outcome.expanded,
    ...(outcome.demotedStale ? { demotedStale: outcome.demotedStale } : {}),
  };
}

/** The `metadata` jsonb of one `retrieval_analytics` row; the breakdown keys exist only when hybrid ran, so their absence means "one list", never "zero hits". */
export function buildRetrievalMetadata(
  resolved: MemorySearchStrategy,
  requested: MemorySearchStrategy,
  breakdown: HybridBreakdown | undefined,
  outcome?: SearchOutcome & { hitIds?: string[] | undefined },
): Record<string, unknown> {
  return {
    strategy: resolved,
    requestedStrategy: requested,
    ...(breakdown ?? {}),
    ...outcomeMetadata(outcome),
  };
}

function outcomeMetadata(outcome: (SearchOutcome & { hitIds?: string[] | undefined }) | undefined) {
  if (!outcome) return {};
  return {
    ...(outcome.reranked ? { reranked: true, rerankMs: outcome.rerankMs } : {}),
    ...(outcome.rerankHoldout ? { rerankHoldout: true } : {}),
    ...(outcome.expanded ? { expanded: true, expandedCount: outcome.expandedCount } : {}),
    ...(outcome.hitIds ? { hitIds: outcome.hitIds } : {}),
  };
}

/**
 * Append-only retrieval log (ISS-274 `retrieval_analytics`). Detached and
 * best-effort — an analytics outage must never fail or slow a search.
 */
function logRetrieval(
  input: RunMemorySearchInput,
  hits: MemoryHit[],
  resolved: MemorySearchStrategy,
  requested: MemorySearchStrategy,
  durationMs: number,
  breakdown: HybridBreakdown | undefined,
  outcome: SearchOutcome,
): void {
  const hitIds =
    requested === 'hybrid' && input.surface === 'agent' ? hits.map((h) => h.id) : undefined;
  queueMicrotask(() => {
    db.insert(retrievalAnalytics)
      .values({
        projectId: input.projectId,
        query: input.query,
        hitCount: hits.length,
        topScore: hits.length > 0 ? (hits[0]?.score ?? null) : null,
        model: env.EMBEDDINGS_MODEL,
        durationMs,
        source: 'api-search',
        metadata: buildRetrievalMetadata(resolved, requested, breakdown, { ...outcome, hitIds }),
      })
      .catch((err) => {
        logger.warn(
          { err: (err as Error).message, projectId: input.projectId },
          'memory.search: retrieval analytics insert failed',
        );
      });
  });
}
