import { type SQL, sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { memories } from './schema.js';
import { identSearchColumn, MEMORY_EMBEDDING_DIM, pgVector, tsVector } from './schema-types.js';

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
    identSearch: identSearchColumn(
      (): SQL => sql`${memoryChunks.contextPrefix} || ' ' || ${memoryChunks.textContent}`,
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
    identSearchIdx: index('memory_chunks_ident_search_idx').using('gin', t.identSearch),
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
