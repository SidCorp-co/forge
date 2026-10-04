import { relations, type SQL, sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { projects } from './schema-projects.js';
import { identSearchColumn, MEMORY_EMBEDDING_DIM, pgVector, tsVector } from './schema-types.js';
import { memorySources } from './schema-vocabulary.js';

export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    source: text('source', { enum: memorySources }).notNull(),
    sourceRef: text('source_ref').notNull(),
    textContent: text('text_content').notNull(),
    // Nullable since memory-v2 phase 1: a degraded write (embeddings outage)
    // stores the row without a vector and the re-embed backfill fills it in.
    // Semantic search filters `embedding IS NOT NULL`.
    embedding: pgVector(MEMORY_EMBEDDING_DIM)('embedding'),
    metadata: jsonb('metadata').notNull().default({}),
    // memory-v2 phase 2 usage tracking: bumped on semantic-search hits only
    // (not natural-key gets) and read by the decay/consolidation jobs.
    retrievalCount: integer('retrieval_count').notNull().default(0),
    lastRetrievedAt: timestamp('last_retrieved_at', { withTimezone: true }),
    // Recall-feedback loop (ISS-603): stamped when an agent verifies the row
    // against live code (`feedback` verdict=confirmed). Decay treats it as
    // activity so a recently-confirmed row is never archived as unused.
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    // Soft delete for decay/consolidation. Archived rows are excluded from
    // every read surface; hard purge happens after a further grace period.
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    // memory-v2 phase 1 keyword retrieval. GENERATED ALWAYS in Postgres
    // (migration 0105) — drizzle must never include it in INSERT/UPDATE.
    textSearch: tsVector('text_search').generatedAlwaysAs(
      (): SQL => sql`to_tsvector('english', left(${memories.textContent}, 100000))`,
    ),
    identSearch: identSearchColumn((): SQL => sql`left(${memories.textContent}, 100000)`),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectSourceIdx: index('memories_project_source_idx').on(t.projectId, t.source),
    projectSourceRefIdx: index('memories_project_source_ref_idx').on(t.projectId, t.sourceRef),
    projectSourceRefUq: uniqueIndex('memories_project_source_ref_uq').on(
      t.projectId,
      t.source,
      t.sourceRef,
    ),
    embeddingHnswIdx: index('memories_embedding_hnsw_idx').using(
      'hnsw',
      sql`"embedding" vector_cosine_ops`,
    ),
    textSearchIdx: index('memories_text_search_idx').using('gin', t.textSearch),
    identSearchIdx: index('memories_ident_search_idx').using('gin', t.identSearch),
    embeddingBackfillIdx: index('memories_embedding_backfill_idx')
      .on(t.updatedAt)
      .where(sql`embedding IS NULL`),
  }),
);

export const memoriesRelations = relations(memories, ({ one }) => ({
  project: one(projects, { fields: [memories.projectId], references: [projects.id] }),
}));

// v1 EPIC 5 (ISS-274) — append-only retrieval log. Today only `/api/memory/search`
// (`source='api-search'`) populates this; EPIC 1's chat-prompt-builder will add
// `source='chat'` rows. No retention sweep yet — see ISS-274 plan Risks.
export const retrievalSources = ['api-search', 'chat'] as const;

export type RetrievalSource = (typeof retrievalSources)[number];

export const retrievalAnalytics = pgTable(
  'retrieval_analytics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    query: text('query').notNull(),
    hitCount: integer('hit_count').notNull(),
    topScore: real('top_score'),
    model: text('model'),
    durationMs: integer('duration_ms'),
    source: text('source', { enum: retrievalSources }).notNull().default('api-search'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectCreatedIdx: index('retrieval_analytics_project_created_idx').on(
      t.projectId,
      t.createdAt,
    ),
  }),
);

export const retrievalAnalyticsRelations = relations(retrievalAnalytics, ({ one }) => ({
  project: one(projects, { fields: [retrievalAnalytics.projectId], references: [projects.id] }),
}));
