import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { cosineDistance } from '../db/pgvector.js';
import { type MemoryModel, type MemorySource, memories } from '../db/schema.js';

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
  /** `chunked` adds the passage arm (memory_chunks joined on the parent's generation) UNION the flat arm on rows not yet chunked; absent or `flat` is the pre-v3 read. */
  memoryModel?: MemoryModel | undefined;
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
  /** 0-based position the reranker gave this hit; present only on a `reranked: true` response. */
  rerankPosition?: number;
  /** Present only on a row appended by relation expansion: the edge kind and the `ISS-n` hit it hangs off. */
  via?: MemoryVia;
  /** On a chunked project, the passage that matched; absent when the flat arm produced the hit. */
  matchedChunk?: { index: number; text: string };
}

/** How an expanded row got into the list — it was not retrieved, it neighbours a hit that was. */
export interface MemoryVia {
  relation: 'blocks' | 'relates';
  from: string;
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

export function clampTopK(topK: number | undefined): number {
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
  if (input.memoryModel === 'chunked') return chunkedSearch(input, 'semantic');
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
  const trimmed = input.query.trim();
  if (!trimmed) return [];
  if (input.memoryModel === 'chunked') return chunkedSearch(input, 'keyword');
  const topK = clampTopK(input.topK);

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

type ChunkedRow = {
  id: string;
  source: string;
  source_ref: string;
  text_content: string;
  metadata: unknown;
  embedded_at: Date | string;
  measure: number | string;
  chunk_index: number | null;
  chunk_text: string | null;
};

function literalFilters(input: BaseSearchInput) {
  const parts = [];
  if (input.sourceFilter && input.sourceFilter.length > 0) {
    parts.push(
      sql`AND m.source IN (${sql.join(
        input.sourceFilter.map((v) => sql`${v}`),
        sql`, `,
      )})`,
    );
  }
  if (input.metadataFilter && Object.keys(input.metadataFilter).length > 0) {
    parts.push(sql`AND m.metadata @> ${JSON.stringify(input.metadataFilter)}::jsonb`);
  }
  return parts.length ? sql.join(parts, sql` `) : sql``;
}

// cm:guard the chunk arm joins `c.generation = m.chunk_generation AND m.chunked_at IS NOT NULL` and the flat arm takes `m.chunked_at IS NULL` — the two are one partition of the project's rows, so a row is read through exactly one arm, a superseded passage set is invisible from the parent's rewrite onward, and a project mid-reindex returns migrated and unmigrated rows in one list. Column names are written LITERALLY because a drizzle column reference inside a raw template renders unqualified, which is ambiguous across the join
async function chunkedSearch(
  input: SearchInput | KeywordSearchInput,
  kind: 'semantic' | 'keyword',
): Promise<MemoryHit[]> {
  const topK = clampTopK(input.topK);
  const filters = literalFilters(input);
  const q =
    kind === 'semantic'
      ? sql`${`[${(input as SearchInput).queryVec.join(',')}]`}::vector`
      : sql`websearch_to_tsquery('english', ${(input as KeywordSearchInput).query.trim()})`;
  const chunkMeasure =
    kind === 'semantic' ? sql`c.embedding <=> ${q}` : sql`ts_rank(c.text_search, ${q})`;
  const flatMeasure =
    kind === 'semantic' ? sql`m.embedding <=> ${q}` : sql`ts_rank(m.text_search, ${q})`;
  const chunkMatch =
    kind === 'semantic' ? sql`AND c.embedding IS NOT NULL` : sql`AND c.text_search @@ ${q}`;
  const flatMatch =
    kind === 'semantic' ? sql`AND m.embedding IS NOT NULL` : sql`AND m.text_search @@ ${q}`;
  const agg = kind === 'semantic' ? sql`MIN` : sql`MAX`;
  const bestFirst = kind === 'semantic' ? sql`ASC` : sql`DESC`;

  const rows = (await db.execute(sql`
    WITH chunk_arm AS (
      SELECT c.memory_id AS id,
             ${agg}(${chunkMeasure}) AS measure,
             (array_agg(c.chunk_index ORDER BY ${chunkMeasure} ${bestFirst}))[1] AS chunk_index,
             (array_agg(c.text_content ORDER BY ${chunkMeasure} ${bestFirst}))[1] AS chunk_text
      FROM memory_chunks c
      JOIN memories m ON m.id = c.memory_id
      WHERE m.project_id = ${input.projectId} AND m.archived_at IS NULL
        AND m.chunked_at IS NOT NULL AND c.generation = m.chunk_generation
        ${chunkMatch} ${filters}
      GROUP BY c.memory_id
    ), flat_arm AS (
      SELECT m.id, ${flatMeasure} AS measure, NULL::int AS chunk_index, NULL::text AS chunk_text
      FROM memories m
      WHERE m.project_id = ${input.projectId} AND m.archived_at IS NULL
        AND m.chunked_at IS NULL ${flatMatch} ${filters}
    ), ranked AS (
      SELECT * FROM chunk_arm UNION ALL SELECT * FROM flat_arm
    )
    SELECT m.id, m.source, m.source_ref, m.text_content, m.metadata, m.embedded_at,
           r.measure, r.chunk_index, r.chunk_text
    FROM ranked r JOIN memories m ON m.id = r.id
    ORDER BY r.measure ${bestFirst}
    LIMIT ${topK}
  `)) as unknown as ChunkedRow[];

  return rows.map((r) => ({
    id: r.id,
    source: r.source as MemorySource,
    sourceRef: r.source_ref,
    text: r.text_content,
    metadata: r.metadata,
    score: kind === 'semantic' ? 1 - Number(r.measure) : Number(r.measure),
    embeddedAt: new Date(r.embedded_at),
    ...deriveMemoryStaleness(r.metadata),
    ...(r.chunk_index !== null && r.chunk_text !== null
      ? { matchedChunk: { index: r.chunk_index, text: r.chunk_text } }
      : {}),
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

/** Sizes of the two ranked lists hybrid fused, and how many ids they shared — what `retrieval_analytics` records per hybrid call. */
export type HybridBreakdown = { semanticHits: number; keywordHits: number; overlap: number };

/**
 * Hybrid strategy — dense + keyword in parallel, fused with weighted RRF
 * (alpha 0.7 dense / 0.3 keyword). Returned `score` is the fused RRF value
 * (≈0.005–0.03), NOT a cosine similarity — callers that threshold on
 * similarity (e.g. the knowledge dedup fact) must use `strategy:'semantic'`.
 */
export async function hybridSearchMemories(
  input: SearchInput & KeywordSearchInput,
): Promise<{ hits: MemoryHit[]; breakdown: HybridBreakdown }> {
  const topK = clampTopK(input.topK);
  const [semantic, keyword] = await Promise.all([
    searchMemories(input),
    keywordSearchMemories(input),
  ]);
  const keywordIds = new Set(keyword.map((h) => h.id));
  const overlap = semantic.filter((h) => keywordIds.has(h.id)).length;
  return {
    hits: reciprocalRankFusion([semantic, keyword], [HYBRID_ALPHA, 1 - HYBRID_ALPHA], topK),
    breakdown: { semanticHits: semantic.length, keywordHits: keyword.length, overlap },
  };
}
