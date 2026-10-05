import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { cosineDistance } from '../db/pgvector.js';
import { type MemorySource, memories } from '../db/schema.js';
import { identifierTsQuery } from '../db/schema-types.js';
import { clampTopK, fuseHybrid } from '../lib/search-fusion.js';
import { memoryOfLiveIssue } from './live-issue.js';

interface BaseSearchInput {
  projectId: string;
  topK?: number | undefined;
  sourceFilter?: MemorySource[] | undefined;
  metadataFilter?: Record<string, string | number | boolean> | undefined;
}

interface SearchInput extends BaseSearchInput {
  queryVec: number[];
}

interface KeywordSearchInput extends BaseSearchInput {
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
}

/** How an expanded row got into the list — it was not retrieved, it neighbours a hit that was. */
export interface MemoryVia {
  relation: 'blocks' | 'relates';
  from: string;
}

/** The columns every memory read that answers hits selects. */
export const MEMORY_HIT_COLUMNS = {
  id: memories.id,
  source: memories.source,
  sourceRef: memories.sourceRef,
  text: memories.textContent,
  metadata: memories.metadata,
  embeddedAt: memories.embeddedAt,
};

type MemoryHitRow = {
  id: string;
  source: string;
  sourceRef: string;
  text: string;
  metadata: unknown;
  embeddedAt: Date;
};

/** A selected row as a hit, with the read-side staleness badge derived from its `metadata`. */
export function toMemoryHit(r: MemoryHitRow, score: number): MemoryHit {
  const md = (r.metadata ?? {}) as Record<string, unknown>;
  const stale = Boolean(md.staleSince);
  return {
    id: r.id,
    source: r.source as MemorySource,
    sourceRef: r.sourceRef,
    text: r.text,
    metadata: r.metadata,
    score,
    embeddedAt: r.embeddedAt,
    ...(typeof md.supersededBy === 'string' ? { stale, supersededBy: md.supersededBy } : { stale }),
  };
}

function baseWhereClauses(input: BaseSearchInput) {
  const whereClauses = [
    eq(memories.projectId, input.projectId),
    // Archived rows are soft-deleted by decay/consolidation.
    isNull(memories.archivedAt),
    memoryOfLiveIssue(input.projectId),
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
      ...MEMORY_HIT_COLUMNS,
      distance: cosineDistance(memories.embedding, input.queryVec).as('distance'),
    })
    .from(memories)
    .where(and(...whereClauses))
    .orderBy(asc(sql`distance`))
    .limit(topK);

  return rows.map((r) => toMemoryHit(r, 1 - Number(r.distance)));
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
  const topK = clampTopK(input.topK);

  const tsQuery = sql`websearch_to_tsquery('english', ${trimmed})`;
  const identQuery = identifierTsQuery(trimmed);
  const whereClauses = baseWhereClauses(input);
  whereClauses.push(
    sql`(${memories.textSearch} @@ ${tsQuery} OR ${memories.identSearch} @@ ${identQuery})`,
  );

  const rows = await db
    .select({
      ...MEMORY_HIT_COLUMNS,
      rank: sql<number>`ts_rank(${memories.textSearch}, ${tsQuery}) + ts_rank(${memories.identSearch}, ${identQuery})`.as(
        'rank',
      ),
    })
    .from(memories)
    .where(and(...whereClauses))
    .orderBy(desc(sql`rank`))
    .limit(topK);

  return rows.map((r) => toMemoryHit(r, Number(r.rank)));
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
 * (`fuseHybrid`). Returned `score` is the fused RRF value
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
    hits: fuseHybrid(semantic, keyword, topK),
    breakdown: { semanticHits: semantic.length, keywordHits: keyword.length, overlap },
  };
}
