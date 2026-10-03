import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { issues, projects, users } from './schema.js';
import { conversationMessages } from './schema-conversations.js';
import { requirements } from './schema-requirements.js';
import { MEMORY_EMBEDDING_DIM, pgVector } from './schema-types.js';

/** The six kinds workflow `suggestion-lifecycle` rev 2 names; the five deferred kinds are not here. */
export const SUGGESTION_KINDS = [
  'requirement_draft',
  'revision_diff',
  'readiness',
  'breakdown',
  'triage',
  'duplicate',
] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

export const SUGGESTION_STATUSES = [
  'proposed',
  'accepted',
  'rejected',
  'stale',
  'withdrawn',
] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

/** Who wrote it: the BA assistant door, an agent credential, or a person through REST. */
export const SUGGESTION_PRODUCERS = ['ba_assistant', 'agent', 'person'] as const;
export type SuggestionProducer = (typeof SUGGESTION_PRODUCERS)[number];

// cm:why the assistant only proposes (workflow suggestion-lifecycle): a row against a base revision
// waits on a person; its effect is written by the accept and points back here, nothing is copied on
export const suggestions = pgTable(
  'suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: SUGGESTION_KINDS }).notNull(),
    // cm:why an exclusive arc of real foreign keys, never a target_type/target_id pair; feedback_id
    // joins the arc with the feedback table (S6)
    requirementId: uuid('requirement_id').references((): AnyPgColumn => requirements.id, {
      onDelete: 'cascade',
    }),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    baseRevision: integer('base_revision'),
    payload: jsonb('payload'),
    payloadVersion: integer('payload_version').notNull().default(1),
    fingerprint: text('fingerprint').notNull(),
    status: text('status', { enum: SUGGESTION_STATUSES }).notNull().default('proposed'),
    producerKind: text('producer_kind', { enum: SUGGESTION_PRODUCERS }).notNull(),
    producerId: uuid('producer_id').references(() => users.id, { onDelete: 'set null' }),
    conversationMessageId: uuid('conversation_message_id').references(
      () => conversationMessages.id,
      { onDelete: 'set null' },
    ),
    model: text('model'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    payloadPurgedAt: timestamp('payload_purged_at', { withTimezone: true }),
  },
  (t) => ({
    arcChk: check('suggestions_arc_chk', sql`num_nonnulls(${t.requirementId}, ${t.issueId}) = 1`),
    kindChk: check(
      'suggestions_kind_chk',
      sql`${t.kind} IN ('requirement_draft', 'revision_diff', 'readiness', 'breakdown', 'triage', 'duplicate')`,
    ),
    statusChk: check(
      'suggestions_status_chk',
      sql`${t.status} IN ('proposed', 'accepted', 'rejected', 'stale', 'withdrawn')`,
    ),
    producerChk: check(
      'suggestions_producer_chk',
      sql`${t.producerKind} IN ('ba_assistant', 'agent', 'person')`,
    ),
    decidedChk: check(
      'suggestions_decided_chk',
      sql`(${t.status} = 'proposed') = (${t.decidedAt} IS NULL)`,
    ),
    rejectedChk: check(
      'suggestions_rejected_chk',
      sql`${t.status} <> 'rejected' OR (${t.reason} ~ '[^[:space:]]' AND ${t.decidedBy} IS NOT NULL)`,
    ),
    payloadChk: check(
      'suggestions_payload_chk',
      sql`${t.payload} IS NOT NULL OR (${t.payloadPurgedAt} IS NOT NULL AND ${t.status} IN ('rejected', 'stale', 'withdrawn'))`,
    ),
    // cm:why one open row per target, kind and fingerprint (SUGGESTION_DUPLICATE), so a retry or a
    // second turn saying the same thing does not queue a twin
    openTwinUq: uniqueIndex('suggestions_open_twin_uq')
      .on(t.kind, sql`coalesce(${t.requirementId}, ${t.issueId})`, t.fingerprint)
      .where(sql`status = 'proposed'`),
    requirementIdx: index('suggestions_requirement_idx')
      .on(t.requirementId, t.status)
      .where(sql`requirement_id IS NOT NULL`),
    issueIdx: index('suggestions_issue_idx')
      .on(t.issueId, t.status)
      .where(sql`issue_id IS NOT NULL`),
    sweepIdx: index('suggestions_status_created_idx').on(t.status, t.createdAt),
  }),
);

export const ITEM_EMBEDDING_STATUSES = ['embedded', 'provider_not_configured', 'failed'] as const;
export type ItemEmbeddingStatus = (typeof ITEM_EMBEDDING_STATUSES)[number];

const itemTypeOf = (requirementId: AnyPgColumn): SQL =>
  sql`CASE WHEN ${requirementId} IS NOT NULL THEN 'requirement' END`;

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
    itemType: text('item_type').generatedAlwaysAs(
      (): SQL => itemTypeOf(itemEmbeddings.requirementId),
    ),
    itemId: uuid('item_id').generatedAlwaysAs(
      (): SQL => sql`coalesce(${itemEmbeddings.requirementId})`,
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
    arcChk: check('item_embeddings_arc_chk', sql`num_nonnulls(${t.requirementId}) = 1`),
    statusChk: check(
      'item_embeddings_status_chk',
      sql`${t.status} IN ('embedded', 'provider_not_configured', 'failed')`,
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
