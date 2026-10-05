import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { cosineDistance } from '../db/pgvector.js';
import { knowledgeEntries } from '../db/schema.js';
import { identifierTsQuery } from '../db/schema-types.js';
import { clampTopK, fuseHybrid } from '../lib/search-fusion.js';

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
