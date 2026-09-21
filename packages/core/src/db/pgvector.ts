import { type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

export function encodeVectorLiteral(vec: readonly number[]): string {
  for (const n of vec) {
    if (!Number.isFinite(n)) {
      throw new Error('vector contains non-finite value (NaN or Infinity)');
    }
  }
  return `[${vec.join(',')}]`;
}

export function cosineDistance(col: AnyPgColumn | SQL, queryVec: readonly number[]): SQL {
  return sql`${col} <=> ${encodeVectorLiteral(queryVec)}::vector`;
}
