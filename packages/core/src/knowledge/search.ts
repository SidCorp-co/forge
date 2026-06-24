import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { cosineDistance } from '../db/pgvector.js';
import { knowledgeEntries } from '../db/schema.js';

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

function clampTopK(topK: number | undefined): number {
  return Math.min(Math.max(topK ?? 10, MIN_TOP_K), MAX_TOP_K);
}

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
      id: knowledgeEntries.id,
      slug: knowledgeEntries.slug,
      kind: knowledgeEntries.kind,
      title: knowledgeEntries.title,
      body: knowledgeEntries.body,
      injection: knowledgeEntries.injection,
      confidence: knowledgeEntries.confidence,
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
  const rows = await db
    .select({
      id: knowledgeEntries.id,
      slug: knowledgeEntries.slug,
      kind: knowledgeEntries.kind,
      title: knowledgeEntries.title,
      body: knowledgeEntries.body,
      injection: knowledgeEntries.injection,
      confidence: knowledgeEntries.confidence,
      rank: sql<number>`ts_rank(${knowledgeEntries.textSearch}, ${tsQuery})`.as('rank'),
    })
    .from(knowledgeEntries)
    .where(and(...baseWhere(projectId), sql`${knowledgeEntries.textSearch} @@ ${tsQuery}`))
    .orderBy(desc(sql`rank`))
    .limit(k);
  return rows.map((r) => ({ ...r, score: Number(r.rank) }));
}

const RRF_K = 60;
const HYBRID_ALPHA = 0.7;

function rrfFuse(lists: KnowledgeHit[][], weights: number[], limit: number): KnowledgeHit[] {
  const scoreMap = new Map<string, { score: number; hit: KnowledgeHit }>();
  for (let li = 0; li < lists.length; li++) {
    const list = lists[li] ?? [];
    const weight = weights[li] ?? 1.0;
    for (let rank = 0; rank < list.length; rank++) {
      const hit = list[rank];
      if (!hit) continue;
      const rrfScore = weight / (RRF_K + rank + 1);
      const existing = scoreMap.get(hit.id);
      if (existing) existing.score += rrfScore;
      else scoreMap.set(hit.id, { score: rrfScore, hit });
    }
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
  return rrfFuse([semantic, keyword], [HYBRID_ALPHA, 1 - HYBRID_ALPHA], k);
}
