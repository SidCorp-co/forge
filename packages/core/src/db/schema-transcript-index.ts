import { type SQL, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { conversations } from './schema-conversations.js';
import { identSearchColumn, tsVector } from './schema-types.js';

/**
 * One bounded run of consecutive transcript text, searchable and source-linked.
 */
export const conversationPassages = pgTable(
  'conversation_passages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    firstSeq: integer('first_seq').notNull(),
    /** Character offset into `first_seq`'s trimmed content where this passage begins. */
    firstOffset: integer('first_offset').notNull().default(0),
    lastSeq: integer('last_seq').notNull(),
    lastOffset: integer('last_offset').notNull(),
    /** How many fragments this passage was cut from — never `last_seq - first_seq + 1`, which counts the rows the rule left out. */
    messageCount: integer('message_count').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
    text: text('text').notNull(),
    isOpen: boolean('is_open').notNull().default(false),
    textSearch: tsVector('text_search').generatedAlwaysAs(
      (): SQL => sql`to_tsvector('english', left(${conversationPassages.text}, 100000))`,
    ),
    identSearch: identSearchColumn((): SQL => sql`left(${conversationPassages.text}, 100000)`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    startUnique: uniqueIndex('conversation_passages_start_unique').on(
      t.conversationId,
      t.firstSeq,
      t.firstOffset,
    ),
    conversationIdx: index('conversation_passages_conversation_idx').on(
      t.conversationId,
      t.firstSeq,
    ),
    openIdx: index('conversation_passages_open_idx').on(t.conversationId).where(sql`is_open`),
    textSearchIdx: index('conversation_passages_text_search_idx').using('gin', t.textSearch),
    identSearchIdx: index('conversation_passages_ident_search_idx').using('gin', t.identSearch),
    seqOrder: check('conversation_passages_seq_order', sql`${t.lastSeq} >= ${t.firstSeq}`),
    countPositive: check('conversation_passages_count_positive', sql`${t.messageCount} > 0`),
    offsetsSane: check(
      'conversation_passages_offsets_sane',
      sql`${t.firstOffset} >= 0 AND ${t.lastOffset} > 0 AND (${t.lastSeq} > ${t.firstSeq} OR ${t.lastOffset} > ${t.firstOffset})`,
    ),
  }),
);

/**
 * How far the index has READ this room's transcript.
 */
export const conversationIndexState = pgTable('conversation_index_state', {
  conversationId: uuid('conversation_id')
    .primaryKey()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  indexedThroughSeq: integer('indexed_through_seq').notNull(),
  /** When the row at the watermark was written, so a limitation can name a time rather than a number. */
  indexedThroughAt: timestamp('indexed_through_at', { withTimezone: true }),
  builderRevision: integer('builder_revision').notNull(),
  indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
});
