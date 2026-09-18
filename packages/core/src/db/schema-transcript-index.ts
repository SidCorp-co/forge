// The index over a room's own past: bounded passages cut from the retained
// transcript, and how far the reader that cut them has read.
//
// It is NOT a second copy of the room. A passage holds the verbatim text of the
// `conversation_messages` rows in its source range and a pointer back at them,
// so dropping every row here and rebuilding from the transcript yields the same
// rows again. Nothing here is generated prose, and nothing here is authority:
// who may read a passage is the room's question, answered live by
// `conversations/scope.ts` at retrieval (ISS-1090).
//
// Split out of `schema-conversations.ts` for size, the way that file was split
// out of `schema.ts`, and registered in `drizzle.config.ts` and the client's
// schema map beside it.

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
// cm:guard keyed by CONVERSATION and never by project, which is the whole reason this table exists rather than a row in `memories`: a room's scope is the union of its live handles' projects, so text filed under one project id is readable by a set of people the room never had. `memory/search-service.ts` says in its own header that it does not authorize; this table's reader does, on every read (ISS-1090 rule 1).
// cm:guard the source range is OFFSET-PRECISE and not merely a seq pair, and that is what makes the row embedding-ready: a message longer than the character bound is cut into consecutive passages, so `first_seq` alone could not say which part of it a passage took, and an embedding pass added later would have to recompute every boundary it was promised it could reuse (ISS-1090, out-of-scope line on embeddings; plan consult F3).
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
    /** Character offset into `last_seq`'s trimmed content one past where this passage ends. */
    lastOffset: integer('last_offset').notNull(),
    /** How many fragments this passage was cut from — never `last_seq - first_seq + 1`, which counts the rows the rule left out. */
    messageCount: integer('message_count').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
    // cm:guard the rows' own text, framed with the speaker and otherwise untouched: a passage that paraphrased would be the rolling room summary ISS-1090 refuses, a second copy of a state the log already holds and which nothing keeps in step with it.
    text: text('text').notNull(),
    // cm:guard the tail the rule has NOT closed, and it is a fact rather than a flaw: the next pass deletes it and re-derives it from its own `(first_seq, first_offset)`, which is what makes an incremental pass write the rows a full rebuild writes. A reader is told so, because a passage that may still grow is not the same claim as one that cannot.
    isOpen: boolean('is_open').notNull().default(false),
    textSearch: tsVector('text_search').generatedAlwaysAs(
      (): SQL => sql`to_tsvector('english', left(${conversationPassages.text}, 100000))`,
    ),
    identSearch: identSearchColumn((): SQL => sql`left(${conversationPassages.text}, 100000)`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // cm:guard one passage per (room, starting fragment), as a database fact: two passes over one room would otherwise each write the same run and a retrieval would return it twice, which reads to the model as two occasions rather than one. The pass takes the room's writer lock as well, and this is what holds if that lock is ever dropped.
    startUnique: uniqueIndex('conversation_passages_start_unique').on(
      t.conversationId,
      t.firstSeq,
      t.firstOffset,
    ),
    conversationIdx: index('conversation_passages_conversation_idx').on(
      t.conversationId,
      t.firstSeq,
    ),
    // cm:guard the open tail is found by its own partial index, because the incremental pass asks for it on every tick and a scan of the room's whole index to find at most one row is the cost this table exists to avoid.
    openIdx: index('conversation_passages_open_idx').on(t.conversationId).where(sql`is_open`),
    textSearchIdx: index('conversation_passages_text_search_idx').using('gin', t.textSearch),
    identSearchIdx: index('conversation_passages_ident_search_idx').using('gin', t.identSearch),
    // cm:guard every CHECK the migration creates is declared here too, because a drizzle snapshot records `checkConstraints` per table: one left in SQL alone is a constraint the snapshot denies.
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
// cm:guard the highest `seq` the pass READ and not the highest it kept: a room whose newest rows are all recorded silences has been read to its end, and a watermark that moved only on kept rows would tell a caller for ever that the room holds messages nobody has indexed. What a retrieval reports is this compared against the transcript's current maximum, measured at read time — so the coverage a caller is told is a measurement and not the writer's claim (ISS-1090 rule 5).
// cm:guard it is also never higher than the row the pass actually read: a pass that took a cut and then indexed a bounded batch below it writes the batch's last seq, so a message appended behind the pass is reported as beyond the index rather than silently covered by it (plan consult F1).
export const conversationIndexState = pgTable('conversation_index_state', {
  conversationId: uuid('conversation_id')
    .primaryKey()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  indexedThroughSeq: integer('indexed_through_seq').notNull(),
  /** When the row at the watermark was written, so a limitation can name a time rather than a number. */
  indexedThroughAt: timestamp('indexed_through_at', { withTimezone: true }),
  // cm:guard the passage RULE's version, and a row holding an older one is rebuilt rather than resumed: the rule decides where every boundary falls, so resuming under a new one would leave a room holding passages no rebuild reproduces — which is the one property this table exists to keep.
  builderRevision: integer('builder_revision').notNull(),
  indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
});
