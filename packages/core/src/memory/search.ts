import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { cosineDistance } from '../db/pgvector.js';
import { type MemorySource, memories } from '../db/schema.js';

interface BaseSearchInput {
  projectId: string;
  topK?: number | undefined;
  sourceFilter?: MemorySource[] | undefined;
  /**
   * Optional JSONB metadata filter. Uses Postgres `@>` containment so every
   * key/value pair must match (`metadata @> filter::jsonb`). All scalar JSON
   * types are supported — strings, numbers, booleans — without per-key casts.
   * Used by the CI-fix pattern learner (`kind:'ci_fix_pattern'`) and step
   * handoff scope queries (`run_id`/`step`/`attempt`).
   */
  metadataFilter?: Record<string, string | number | boolean> | undefined;
}

export interface SearchInput extends BaseSearchInput {
  queryVec: number[];
}

export interface KeywordSearchInput extends BaseSearchInput {
  query: string;
}

export interface MemoryHit {
  id: string;
  source: MemorySource;
  sourceRef: string;
  text: string;
  metadata: unknown;
  score: number;
  embeddedAt: Date;
  /** True when `metadata.staleSince` is set — a later release may have
   *  contradicted this row (see `reconcileForReleasedIssue`). */
  stale: boolean;
  /** `"ISS-<n>"` provenance when a release flagged this row; only present
   *  alongside `stale: true`. */
  supersededBy?: string;
}

/**
 * Derive the read-side staleness badge from a row's `metadata` jsonb.
 * Pure so both search strategies (and their tests) share one source of truth.
 */
export function deriveMemoryStaleness(metadata: unknown): {
  stale: boolean;
  supersededBy?: string;
} {
  const md = (metadata ?? {}) as Record<string, unknown>;
  const stale = Boolean(md.staleSince);
  return typeof md.supersededBy === 'string' ? { stale, supersededBy: md.supersededBy } : { stale };
}

const MIN_TOP_K = 1;
const MAX_TOP_K = 50;

function clampTopK(topK: number | undefined): number {
  return Math.min(Math.max(topK ?? 10, MIN_TOP_K), MAX_TOP_K);
}

function baseWhereClauses(input: BaseSearchInput) {
  const whereClauses = [
    eq(memories.projectId, input.projectId),
    // Archived rows are soft-deleted by decay/consolidation.
    isNull(memories.archivedAt),
  ];
  if (input.sourceFilter && input.sourceFilter.length > 0) {
    whereClauses.push(inArray(memories.source, input.sourceFilter));
  }
  if (input.metadataFilter && Object.keys(input.metadataFilter).length > 0) {
    whereClauses.push(sql`${memories.metadata} @> ${JSON.stringify(input.metadataFilter)}::jsonb`);
  }
  return whereClauses;
}

/** Semantic (dense vector) strategy — cosine over the HNSW index. */
export async function searchMemories(input: SearchInput): Promise<MemoryHit[]> {
  const topK = clampTopK(input.topK);

  const whereClauses = baseWhereClauses(input);
  // Degraded writes (embeddings outage) have no vector until the backfill
  // re-embeds them.
  whereClauses.push(isNotNull(memories.embedding));

  const rows = await db
    .select({
      id: memories.id,
      source: memories.source,
      sourceRef: memories.sourceRef,
      text: memories.textContent,
      metadata: memories.metadata,
      embeddedAt: memories.embeddedAt,
      distance: cosineDistance(memories.embedding, input.queryVec).as('distance'),
    })
    .from(memories)
    .where(and(...whereClauses))
    .orderBy(asc(sql`distance`))
    .limit(topK);

  return rows.map((r) => ({
    id: r.id,
    source: r.source as MemorySource,
    sourceRef: r.sourceRef,
    text: r.text,
    metadata: r.metadata,
    score: 1 - Number(r.distance),
    embeddedAt: r.embeddedAt,
    ...deriveMemoryStaleness(r.metadata),
  }));
}

/**
 * Keyword strategy — Postgres FTS over the generated `text_search` column
 * (GIN-indexed, migration 0105). `websearch_to_tsquery` accepts free-form
 * user queries (quoted phrases, `-exclusions`, `or`) and never throws on
 * malformed input. No embedding call — works during embeddings outages and
 * finds exact identifiers (error codes, file names) that cosine misses.
 *
 * Scores are `ts_rank` values — NOT comparable to cosine similarity. Rank
 * within a strategy is meaningful; absolute values across strategies are not,
 * which is why `hybridSearchMemories` fuses by rank (RRF), not by score.
 */
export async function keywordSearchMemories(input: KeywordSearchInput): Promise<MemoryHit[]> {
  const topK = clampTopK(input.topK);
  const trimmed = input.query.trim();
  if (!trimmed) return [];

  const tsQuery = sql`websearch_to_tsquery('english', ${trimmed})`;
  const whereClauses = baseWhereClauses(input);
  whereClauses.push(sql`${memories.textSearch} @@ ${tsQuery}`);

  const rows = await db
    .select({
      id: memories.id,
      source: memories.source,
      sourceRef: memories.sourceRef,
      text: memories.textContent,
      metadata: memories.metadata,
      embeddedAt: memories.embeddedAt,
      rank: sql<number>`ts_rank(${memories.textSearch}, ${tsQuery})`.as('rank'),
    })
    .from(memories)
    .where(and(...whereClauses))
    .orderBy(desc(sql`rank`))
    .limit(topK);

  return rows.map((r) => ({
    id: r.id,
    source: r.source as MemorySource,
    sourceRef: r.sourceRef,
    text: r.text,
    metadata: r.metadata,
    score: Number(r.rank),
    embeddedAt: r.embeddedAt,
    ...deriveMemoryStaleness(r.metadata),
  }));
}

/** Standard RRF constant — higher k flattens the advantage of top ranks. */
const RRF_K = 60;
/** Dense-vector weight in hybrid fusion (keyword gets `1 - alpha`). */
const HYBRID_ALPHA = 0.7;

/**
 * Reciprocal Rank Fusion — merge ranked lists by rank, not score, so the
 * incomparable scales (cosine similarity vs ts_rank) never mix. A hit found
 * by multiple strategies accumulates: `Σ weight_i / (k + rank_i)`.
 *
 * Ported from forge-agents `embeddings/multi-search.ts`.
 */
export function reciprocalRankFusion(
  rankedLists: MemoryHit[][],
  weights: number[],
  limit: number,
  k = RRF_K,
): MemoryHit[] {
  const scoreMap = new Map<string, { score: number; hit: MemoryHit }>();

  for (let listIdx = 0; listIdx < rankedLists.length; listIdx++) {
    const list = rankedLists[listIdx] ?? [];
    const weight = weights[listIdx] ?? 1.0;

    for (let rank = 0; rank < list.length; rank++) {
      const hit = list[rank];
      if (!hit) continue;
      const rrfScore = weight / (k + rank + 1); // rank is 0-based, RRF uses 1-based
      const existing = scoreMap.get(hit.id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(hit.id, { score: rrfScore, hit });
      }
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, hit }) => ({ ...hit, score }));
}

/**
 * memory-v2 phase 2 — usage tracking. One statement, fire-and-forget from
 * callers (a tracking failure must never fail a search). Feeds the decay
 * job: rows that are never retrieved are the first to be archived.
 */
export async function touchMemories(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(memories)
    .set({
      retrievalCount: sql`${memories.retrievalCount} + 1`,
      lastRetrievedAt: sql`now()`,
    })
    .where(inArray(memories.id, ids));
}

/**
 * Hybrid strategy — dense + keyword in parallel, fused with weighted RRF
 * (alpha 0.7 dense / 0.3 keyword). Returned `score` is the fused RRF value
 * (≈0.005–0.03), NOT a cosine similarity — callers that threshold on
 * similarity (e.g. the knowledge dedup fact) must use `strategy:'semantic'`.
 */
export async function hybridSearchMemories(
  input: SearchInput & KeywordSearchInput,
): Promise<MemoryHit[]> {
  const topK = clampTopK(input.topK);
  const [semantic, keyword] = await Promise.all([
    searchMemories(input),
    keywordSearchMemories(input),
  ]);
  return reciprocalRankFusion([semantic, keyword], [HYBRID_ALPHA, 1 - HYBRID_ALPHA], topK);
}
