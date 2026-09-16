// Column types and the identifier-search helpers shared by `schema.ts` and its
// sibling schema modules. Split out of `schema.ts` for size, like
// `schema-memory-chunks.ts`; nothing here touches a table.

import { type SQL, sql } from 'drizzle-orm';
import { customType } from 'drizzle-orm/pg-core';

export const MEMORY_EMBEDDING_DIM = 1536;

/**
 * pgvector column type. Dimension is fixed per column — `memories.embedding`
 * uses `vector(1536)` per ADR 0011. Stored as a bracketed string on the wire
 * (`[0.1,0.2,...]`), deserialised to number[] by the driver.
 */
export const pgVector = (dim: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dim})`;
    },
    toDriver(v) {
      return `[${v.join(',')}]`;
    },
    fromDriver(v) {
      return typeof v === 'string' ? (JSON.parse(v) as number[]) : (v as number[]);
    },
  });

/**
 * Postgres full-text search vector. Generated column — never written by the
 * app; Postgres derives it from the row's text. Read via `@@` / `ts_rank` in
 * the keyword retrieval strategy (memory-v2 phase 1).
 */
export const tsVector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

/** The `ident_search` column: the row's text with camelCase, `_`, `/`, `.`, `:` and `-` split into `simple`-config words, so `LITELLM_API` finds `LITELLM_API_URL` and `cascade` finds `runs-cascade.ts`. */
export const identSearchColumn = (text: () => SQL) =>
  tsVector('ident_search').generatedAlwaysAs(
    (): SQL => sql`to_tsvector('simple', forge_identifier_words(${text()}))`,
  );

/** The query side of the identifier arm: the same split, as a phrase, so the words must stand adjacent — `ISS-26` does not match a row that has `iss` and `26` apart. */
export const identifierTsQuery = (query: string): SQL =>
  sql`phraseto_tsquery('simple', forge_identifier_words(${query}))`;
