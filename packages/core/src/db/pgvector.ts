import { type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * Encode a `number[]` into pgvector's text literal form (`[0.1,0.2,...]`).
 *
 * Rejects non-finite values — `NaN`/`Infinity` are not representable in a
 * pgvector column and silently serialising them would produce a runtime
 * parse error server-side. The caller is expected to normalise upstream.
 */
export function encodeVectorLiteral(vec: readonly number[]): string {
  for (const n of vec) {
    if (!Number.isFinite(n)) {
      throw new Error('vector contains non-finite value (NaN or Infinity)');
    }
  }
  return `[${vec.join(',')}]`;
}

/**
 * Cosine distance (`<=>`) between a pgvector column and a query vector.
 *
 * Intended for `orderBy` clauses on the `memories.embedding` column which is
 * backed by the `vector_cosine_ops` HNSW index (ADR 0011). Score is
 * `1 - distance` — caller maps if a bounded similarity is preferred.
 *
 * Usage:
 *   db.select({ ..., distance: cosineDistance(memories.embedding, vec).as('distance') })
 *     .from(memories)
 *     .orderBy(asc(sql`distance`));
 */
export function cosineDistance(col: AnyPgColumn | SQL, queryVec: readonly number[]): SQL {
  return sql`${col} <=> ${encodeVectorLiteral(queryVec)}::vector`;
}
