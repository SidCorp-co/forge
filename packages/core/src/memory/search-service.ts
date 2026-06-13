import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { type MemorySource, retrievalAnalytics } from '../db/schema.js';
import { EmbeddingUnavailableError, embed } from '../embeddings/index.js';
import { logger } from '../logger.js';
import {
  type MemoryHit,
  hybridSearchMemories,
  keywordSearchMemories,
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

export interface RunMemorySearchInput {
  projectId: string;
  query: string;
  topK?: number | undefined;
  sourceFilter?: MemorySource[] | undefined;
  strategy?: MemorySearchStrategy | undefined;
}

export interface MemorySearchResult {
  hits: MemoryHit[];
  model: string;
  took_ms: number;
  /** Strategy actually executed — differs from the request when degraded. */
  strategy: MemorySearchStrategy;
  /** True when hybrid fell back to keyword because embeddings were down. */
  degraded?: boolean;
}

export async function runMemorySearch(input: RunMemorySearchInput): Promise<MemorySearchResult> {
  const startedAt = Date.now();
  const requested: MemorySearchStrategy = input.strategy ?? 'semantic';
  let resolved: MemorySearchStrategy = requested;
  let degraded = false;
  let hits: MemoryHit[];

  const base = {
    projectId: input.projectId,
    topK: input.topK,
    sourceFilter: input.sourceFilter,
  };

  if (requested === 'keyword') {
    hits = await keywordSearchMemories({ ...base, query: input.query });
  } else {
    try {
      const queryVec = await embed(input.query);
      hits =
        requested === 'hybrid'
          ? await hybridSearchMemories({ ...base, queryVec, query: input.query })
          : await searchMemories({ ...base, queryVec });
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError && requested === 'hybrid') {
        // Keyword needs no embedding — serve degraded results instead of 503.
        logger.warn(
          { projectId: input.projectId, err: (err as Error).message },
          'memory.search: embeddings unavailable, hybrid degraded to keyword',
        );
        resolved = 'keyword';
        degraded = true;
        hits = await keywordSearchMemories({ ...base, query: input.query });
      } else {
        throw err;
      }
    }
  }

  const tookMs = Date.now() - startedAt;
  logRetrieval(input, hits, resolved, requested, tookMs);

  // Usage tracking (phase 2) — detached; a tracking failure never fails the
  // search. Natural-key reads (forge_memory.get) intentionally do NOT count.
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
    strategy: resolved,
    ...(degraded ? { degraded: true } : {}),
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
): void {
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
        metadata: { strategy: resolved, requestedStrategy: requested },
      })
      .catch((err) => {
        logger.warn(
          { err: (err as Error).message, projectId: input.projectId },
          'memory.search: retrieval analytics insert failed',
        );
      });
  });
}
