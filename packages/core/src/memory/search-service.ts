import type { RerankReport } from '@forge/contracts/memory';
import { z } from 'zod';
import { type MemorySource, memorySources } from '../db/schema.js';
import {
  EmbeddingUnavailableError,
  embedQuery,
  fastModelConfigured,
} from '../integrations/llm/index.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { RETRIEVAL_FLAGS, type RetrievalFlags } from '../lib/retrieval-flags.js';
import { clampTopK } from '../lib/search-fusion.js';
import { expandIssueRelations } from './expand-relations.js';
import { inRerankHoldout, rerankHits, rerankPoolSize } from './rerank.js';
import {
  hybridSearchMemories,
  keywordSearchMemories,
  type MemoryHit,
  searchMemories,
  touchMemories,
} from './search.js';

/**
 * Run a memory search. Shared between the `POST /api/memory/search` REST
 * route and the in-app assistant's memory search (ISS-202) so both surfaces
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

const memorySearchStrategies = ['semantic', 'keyword', 'hybrid'] as const;
type MemorySearchStrategy = (typeof memorySearchStrategies)[number];

/** A search request as `POST /api/memory/search` and `forge_memory` `search` both take it. */
export const memorySearchInputSchema = z.object({
  projectId: z.uuid(),
  query: z.string().trim().min(1).max(4000),
  topK: z.number().int().min(1).max(50).default(10),
  sourceFilter: z.array(z.enum(memorySources)).optional(),
  strategy: z.enum(memorySearchStrategies).default('semantic'),
});

const memorySearchSurfaces = ['agent', 'web'] as const;
type MemorySearchSurface = (typeof memorySearchSurfaces)[number];

interface RunMemorySearchInput {
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

interface MemorySearchResult {
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
  /** Present whenever a rerank was attempted: the path that ordered the hits, the model version, and a degradation when the model path was not taken. */
  rerank?: RerankReport;
  /** Present only on an eligible search that was deliberately left in RRF order as the pilot's control. */
  rerankHoldout?: true;
  /** True when rows carrying `via` were appended after the ranked hits. */
  expanded: boolean;
  /** How many retrieved hits were moved below the fresh ones because they carry `staleSince`. Absent when none were. */
  demotedStale?: number;
}

/** What one search did beyond retrieving — the fields the response carries. */
interface SearchOutcome {
  reranked: boolean;
  rerank?: RerankReport;
  rerankHoldout?: true;
  expanded: boolean;
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
): Promise<{
  hits: MemoryHit[];
  resolved: MemorySearchStrategy;
  degraded: boolean;
  embedMs?: number;
}> {
  const requested: MemorySearchStrategy = input.strategy ?? 'semantic';
  const base = {
    projectId: input.projectId,
    topK: input.topK,
    sourceFilter: input.sourceFilter,
  };
  if (requested === 'keyword') {
    const hits = await keywordSearchMemories({ ...base, query: input.query });
    return { hits, resolved: requested, degraded: false };
  }
  const embedStarted = Date.now();
  const attempted = input.queryVec === undefined;
  const embedMsNow = () => (attempted ? { embedMs: Date.now() - embedStarted } : {});
  try {
    const queryVec = input.queryVec ?? (await embedQuery({ surface: 'memory' }, input.query));
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
  const topK = clampTopK(input.topK);
  const flags = RETRIEVAL_FLAGS;
  const eligible = rerankEligible(input, flags);
  const holdout = eligible && inRerankHoldout();
  const willRerank = eligible && !holdout;

  const retrieved = await retrieve(input, willRerank ? rerankPoolSize(topK) : topK);
  let hits = retrieved.hits;
  const outcome: SearchOutcome = { reranked: false, expanded: false };
  if (holdout) outcome.rerankHoldout = true;

  if (willRerank && retrieved.resolved === 'hybrid') {
    const result = await rerankHits({ query: input.query, hits, topK });
    hits = result.hits;
    outcome.reranked = result.report.path === 'model';
    outcome.rerank = result.report;
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
    }
  }

  const tookMs = Date.now() - startedAt;
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
    ...(outcome.rerank ? { rerank: outcome.rerank } : {}),
    ...(outcome.rerankHoldout ? { rerankHoldout: true as const } : {}),
    expanded: outcome.expanded,
    ...(outcome.demotedStale ? { demotedStale: outcome.demotedStale } : {}),
  };
}
