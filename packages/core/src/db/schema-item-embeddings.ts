import { ITEM_EMBEDDING_STATUSES } from '@forge/contracts/suggestions';
import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { feedback } from './schema-feedback.js';
import { projects } from './schema-projects.js';
import { requirements } from './schema-requirements.js';
import { MEMORY_EMBEDDING_DIM, pgVector } from './schema-types.js';

export { ITEM_EMBEDDING_STATUSES, type ItemEmbeddingStatus } from '@forge/contracts/suggestions';

const itemTypeOf = (requirementId: AnyPgColumn, feedbackId: AnyPgColumn): SQL =>
  sql`CASE WHEN ${requirementId} IS NOT NULL THEN 'requirement' WHEN ${feedbackId} IS NOT NULL THEN 'feedback' END`;

// cm:why separate from memories (Q7): a missed source filter on memory recall would leak requirements
// into it. One row per item holds its head revision only; the arc cascades the row with its item
export const itemEmbeddings = pgTable(
  'item_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    requirementId: uuid('requirement_id').references((): AnyPgColumn => requirements.id, {
      onDelete: 'cascade',
    }),
    feedbackId: uuid('feedback_id').references((): AnyPgColumn => feedback.id, {
      onDelete: 'cascade',
    }),
    itemType: text('item_type').generatedAlwaysAs(
      (): SQL => itemTypeOf(itemEmbeddings.requirementId, itemEmbeddings.feedbackId),
    ),
    itemId: uuid('item_id').generatedAlwaysAs(
      (): SQL => sql`coalesce(${itemEmbeddings.requirementId}, ${itemEmbeddings.feedbackId})`,
    ),
    /** The item's revision this vector was taken from: its head when written. */
    version: integer('version').notNull(),
    model: text('model'),
    embedding: pgVector(MEMORY_EMBEDDING_DIM)('embedding'),
    contentHash: text('content_hash').notNull(),
    status: text('status', { enum: ITEM_EMBEDDING_STATUSES }).notNull(),
    error: text('error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    arcChk: check(
      'item_embeddings_arc_chk',
      sql`num_nonnulls(${t.requirementId}, ${t.feedbackId}) = 1`,
    ),
    statusChk: check(
      'item_embeddings_status_chk',
      sql`${t.status} IN (${sql.raw(ITEM_EMBEDDING_STATUSES.map((s) => `'${s}'`).join(', '))})`,
    ),
    embeddedChk: check(
      'item_embeddings_embedded_chk',
      sql`(${t.status} = 'embedded') = (${t.embedding} IS NOT NULL AND ${t.model} IS NOT NULL)`,
    ),
    itemUq: uniqueIndex('item_embeddings_item_uq').on(t.itemType, t.itemId),
    projectIdx: index('item_embeddings_project_idx').on(t.projectId, t.itemType),
    hnswIdx: index('item_embeddings_embedding_hnsw_idx').using(
      'hnsw',
      sql`"embedding" vector_cosine_ops`,
    ),
  }),
);
