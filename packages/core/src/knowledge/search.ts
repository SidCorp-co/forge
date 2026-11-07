import type { CuratedEntryType, KnowledgeProvenance, RecheckDue } from '@forge/contracts/knowledge';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { cosineDistance } from '../db/pgvector.js';
import { knowledgeEntries } from '../db/schema.js';
import { identifierTsQuery } from '../db/schema-types.js';
import { clampTopK, fuseHybrid } from '../lib/search-fusion.js';
import { notAWithdrawnLesson } from './lesson-entries.js';
import { recheckDueOf } from './recheck.js';

export interface KnowledgeHit extends KnowledgeProvenance {
  id: string;
  projectId: string;
  slug: string;
  kind: string;
  title: string;
  body: string;
  injection: string;
  confidence: string;
  /** fact, hypothesis or convention; null on an entry owing it (ISS-1121). */
  type: CuratedEntryType | null;
  /** A re-check a landing or a rule change flagged on it; null where none stands. */
  recheckDue: RecheckDue | null;
  score: number;
}

const HIT_COLUMNS = {
  id: knowledgeEntries.id,
  projectId: knowledgeEntries.projectId,
  slug: knowledgeEntries.slug,
  kind: knowledgeEntries.kind,
  title: knowledgeEntries.title,
  body: knowledgeEntries.body,
  injection: knowledgeEntries.injection,
  confidence: knowledgeEntries.confidence,
  source: knowledgeEntries.source,
  scope: knowledgeEntries.scope,
  recheckWhen: knowledgeEntries.recheckWhen,
  type: knowledgeEntries.entryType,
  metadata: knowledgeEntries.metadata,
};

type HitRow = { metadata: unknown } & Omit<KnowledgeHit, 'recheckDue' | 'score'>;

const hitOf = ({ metadata, ...r }: HitRow, score: number): KnowledgeHit => ({
  ...r,
  recheckDue: recheckDueOf((metadata as Record<string, unknown> | null)?.recheckDue),
  score,
});

function baseWhere(projectId: string | readonly string[]) {
  // a held or retired lesson is never retrieved as if it applied; it stays readable by its slug
  return [
    typeof projectId === 'string'
      ? eq(knowledgeEntries.projectId, projectId)
      : inArray(knowledgeEntries.projectId, [...projectId]),
    isNull(knowledgeEntries.archivedAt),
    notAWithdrawnLesson,
  ];
}

/** Semantic (dense vector) cosine search over the HNSW index, of one project or several. */
export async function searchKnowledge(
  projectId: string | readonly string[],
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
  return rows.map(({ distance, ...r }) => hitOf(r, 1 - Number(distance)));
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
  return rows.map(({ rank, ...r }) => hitOf(r, Number(rank)));
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
