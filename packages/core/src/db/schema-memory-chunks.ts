// The chunked memory model's passage table (ISS-906): one row per ~1,200-character
// passage of a memory in a project whose `app_config.memory_model` is `chunked`,
// stamped with the parent's `chunk_generation` at write time.
//
// Split out of `schema.ts` only for size; it is a schema module like
// `schema-journal.ts` and is registered in `drizzle.config.ts` and the drizzle
// client's schema map alongside it.

import { type SQL, sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { MEMORY_EMBEDDING_DIM, memories, pgVector, tsVector } from './schema.js';

// cm:guard a sibling table, never a re-key of `memories` — `get`, `decay`, `consolidation`, `feedback`, the candidates and the near-duplicate probe all read one row per natural key and none of them knows this table exists; a chunk is reachable ONLY through the search arm's join on the parent's `chunked_at` and `chunk_generation`, so nothing here may be selected without that join
export const memoryChunks = pgTable(
  'memory_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memoryId: uuid('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    textContent: text('text_content').notNull(),
    contextPrefix: text('context_prefix').notNull(),
    embedding: pgVector(MEMORY_EMBEDDING_DIM)('embedding'),
    generation: integer('generation').notNull(),
    textSearch: tsVector('text_search').generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('english', ${memoryChunks.contextPrefix} || ' ' || ${memoryChunks.textContent})`,
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    memoryChunkUq: uniqueIndex('memory_chunks_memory_chunk_uq').on(t.memoryId, t.chunkIndex),
    embeddingHnswIdx: index('memory_chunks_embedding_hnsw_idx').using(
      'hnsw',
      sql`"embedding" vector_cosine_ops`,
    ),
    textSearchIdx: index('memory_chunks_text_search_idx').using('gin', t.textSearch),
  }),
);

/** The `memory_reindex` jsonb's `state`; written only by memory/chunk-reindex.ts and the memory-model routes. */
export const memoryReindexStates = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type MemoryReindexState = (typeof memoryReindexStates)[number];
