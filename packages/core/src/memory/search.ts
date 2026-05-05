import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { cosineDistance } from '../db/pgvector.js';
import {
  type MemoryRole,
  type MemorySource,
  type MemoryVisibility,
  memories,
} from '../db/schema.js';
import { allowedRoleVisibilityPairs } from './visibility.js';

export interface SearchInput {
  projectId: string;
  queryVec: number[];
  topK?: number | undefined;
  sourceFilter?: MemorySource[] | undefined;
  // Omitted ⇒ no role filter (back-compat for callers that haven't been
  // wired up yet). An explicit empty array means "narrow to nothing" and
  // short-circuits to []; non-empty restricts hits to the (role, visibility)
  // pairs the viewer can see. The REST/MCP schemas reject `[]` upstream so
  // the short-circuit only fires for internal callers passing `[]` directly.
  allowedRoles?: MemoryRole[] | undefined;
}

export interface MemoryHit {
  id: string;
  source: MemorySource;
  sourceRef: string;
  text: string;
  metadata: unknown;
  role: MemoryRole;
  visibility: MemoryVisibility;
  retrievalCount: number;
  category: string | null;
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

  if (input.allowedRoles !== undefined) {
    // Explicit empty array ⇒ caller wants no results. Treating it as
    // "no filter" silently would be surprising (and a security smell if
    // an upstream bug ever produced an empty list).
    if (input.allowedRoles.length === 0) return [];
    const pairs = allowedRoleVisibilityPairs(input.allowedRoles);
    if (pairs.length === 0) return [];
    const pairClauses = pairs.map((p) =>
      and(eq(memories.role, p.role), eq(memories.visibility, p.visibility)),
    );
    const combined = pairClauses.length === 1 ? pairClauses[0] : or(...pairClauses);
    if (combined) whereClauses.push(combined);
  }

  const rows = await db
    .select({
      id: memories.id,
      source: memories.source,
      sourceRef: memories.sourceRef,
      text: memories.textContent,
      metadata: memories.metadata,
      role: memories.role,
      visibility: memories.visibility,
      retrievalCount: memories.retrievalCount,
      category: memories.category,
      embeddedAt: memories.embeddedAt,
      distance: cosineDistance(memories.embedding, input.queryVec).as('distance'),
    })
    .from(memories)
    .where(and(...whereClauses))
    .orderBy(asc(sql`distance`))
    .limit(topK);

  if (rows.length > 0) {
    // Atomic SQL-side `+ 1` so 100 concurrent searches over the same memory
    // each contribute exactly one increment.
    const ids = rows.map((r) => r.id);
    await db
      .update(memories)
      .set({ retrievalCount: sql`${memories.retrievalCount} + 1` })
      .where(inArray(memories.id, ids));
  }

  return rows.map((r) => ({
    id: r.id,
    source: r.source as MemorySource,
    sourceRef: r.sourceRef,
    text: r.text,
    metadata: r.metadata,
    role: r.role as MemoryRole,
    visibility: r.visibility as MemoryVisibility,
    retrievalCount: r.retrievalCount,
    category: r.category,
    score: 1 - Number(r.distance),
    embeddedAt: r.embeddedAt,
  }));
}
