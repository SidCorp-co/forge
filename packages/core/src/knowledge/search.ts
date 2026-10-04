import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { cosineDistance } from '../db/pgvector.js';
import { knowledgeEntries } from '../db/schema.js';
import { identifierTsQuery } from '../db/schema-types.js';

export interface KnowledgeHit {
  id: string;
  slug: string;
  kind: string;
  title: string;
  body: string;
  injection: string;
  confidence: string;
  score: number;
}

const MIN_TOP_K = 1;
const MAX_TOP_K = 50;

export function clampTopK(topK: number | undefined): number {
  return Math.min(Math.max(topK ?? 10, MIN_TOP_K), MAX_TOP_K);
}

const HIT_COLUMNS = {
  id: knowledgeEntries.id,
  slug: knowledgeEntries.slug,
  kind: knowledgeEntries.kind,
  title: knowledgeEntries.title,
  body: knowledgeEntries.body,
  injection: knowledgeEntries.injection,
  confidence: knowledgeEntries.confidence,
};

function baseWhere(projectId: string) {
  return [eq(knowledgeEntries.projectId, projectId), isNull(knowledgeEntries.archivedAt)];
}

/** Semantic (dense vector) cosine search over the HNSW index. */
export async function searchKnowledge(
  projectId: string,
  queryVec: number[],
  topK?: number,
): Promise<KnowledgeHit[]> {
  const k = clampTopK(topK);
  const rows = await db
    .select({
      ...HIT_COLUMNS,
      distance: cosineDistance(knowledgeEntries.embedding, queryVec).as('distance'),
    })
    .from(knowledgeEntries)
    .where(and(...baseWhere(projectId), isNotNull(knowledgeEntries.embedding)))
    .orderBy(asc(sql`distance`))
    .limit(k);
  return rows.map((r) => ({ ...r, score: 1 - Number(r.distance) }));
}

/** Keyword search — Postgres FTS over the generated text_search column. */
export async function keywordSearchKnowledge(
  projectId: string,
  query: string,
  topK?: number,
): Promise<KnowledgeHit[]> {
  const k = clampTopK(topK);
  const trimmed = query.trim();
  if (!trimmed) return [];

  const tsQuery = sql`websearch_to_tsquery('english', ${trimmed})`;
  const identQuery = identifierTsQuery(trimmed);
  const rows = await db
    .select({
      ...HIT_COLUMNS,
      rank: sql<number>`ts_rank(${knowledgeEntries.textSearch}, ${tsQuery}) + ts_rank(${knowledgeEntries.identSearch}, ${identQuery})`.as(
        'rank',
      ),
    })
    .from(knowledgeEntries)
    .where(
      and(
        ...baseWhere(projectId),
        sql`(${knowledgeEntries.textSearch} @@ ${tsQuery} OR ${knowledgeEntries.identSearch} @@ ${identQuery})`,
      ),
    )
    .orderBy(desc(sql`rank`))
    .limit(k);
  return rows.map((r) => ({ ...r, score: Number(r.rank) }));
}

/** Standard RRF constant — higher k flattens the advantage of top ranks. */
const RRF_K = 60;
/** Dense-vector weight in hybrid fusion (keyword gets `1 - alpha`). */
const HYBRID_ALPHA = 0.5;

/**
 * Weighted reciprocal-rank fusion of a dense and a keyword list, the one fusion memory and
 * knowledge hybrid search share. The returned `score` is the fused RRF value.
 */
export function fuseHybrid<T extends { id: string; score: number }>(
  semantic: T[],
  keyword: T[],
  limit: number,
): T[] {
  const scoreMap = new Map<string, { score: number; hit: T }>();
  const weighted: Array<[T[], number]> = [
    [semantic, HYBRID_ALPHA],
    [keyword, 1 - HYBRID_ALPHA],
  ];
  for (const [list, weight] of weighted) {
    list.forEach((hit, rank) => {
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

/** Hybrid search — dense + keyword fused with weighted RRF. */
export async function hybridSearchKnowledge(
  projectId: string,
  queryVec: number[],
  query: string,
  topK?: number,
): Promise<KnowledgeHit[]> {
  const k = clampTopK(topK);
  const [semantic, keyword] = await Promise.all([
    searchKnowledge(projectId, queryVec, k),
    keywordSearchKnowledge(projectId, query, k),
  ]);
  return fuseHybrid(semantic, keyword, k);
}
