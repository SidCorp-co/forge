import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { cosineDistance } from '../db/pgvector.js';
import { type MemorySource, memories } from '../db/schema.js';

export interface SearchInput {
  projectId: string;
  queryVec: number[];
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

export interface MemoryHit {
  id: string;
  source: MemorySource;
  sourceRef: string;
  text: string;
  metadata: unknown;
  score: number;
  embeddedAt: Date;
}

const MIN_TOP_K = 1;
const MAX_TOP_K = 50;

export async function searchMemories(input: SearchInput): Promise<MemoryHit[]> {
  const topK = Math.min(Math.max(input.topK ?? 10, MIN_TOP_K), MAX_TOP_K);

  const whereClauses = [eq(memories.projectId, input.projectId)];
  if (input.sourceFilter && input.sourceFilter.length > 0) {
    whereClauses.push(inArray(memories.source, input.sourceFilter));
  }
  if (input.metadataFilter && Object.keys(input.metadataFilter).length > 0) {
    whereClauses.push(
      sql`${memories.metadata} @> ${JSON.stringify(input.metadataFilter)}::jsonb`,
    );
  }

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
  }));
}
