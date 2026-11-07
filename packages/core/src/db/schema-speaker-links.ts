import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { projects } from './schema-projects.js';
import { conversationAdapters } from './schema-vocabulary.js';

/**
 * How a link was confirmed: the chat server reported the person's Forge address, or (until ISS-845
 * removed that door) the person minted a code and wrote it in a bound room; rows linked so stand.
 */
export const speakerLinkConfirmations = ['channel_email_match', 'chat_code'] as const;
export type SpeakerLinkConfirmation = (typeof speakerLinkConfirmations)[number];

export const assistantSpeakerLinks = pgTable(
  'assistant_speaker_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source', { enum: conversationAdapters }).notNull(),
    externalNamespace: text('external_namespace').notNull(),
    externalId: text('external_id').notNull(),
    externalLabel: text('external_label'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    confirmedVia: text('confirmed_via', { enum: speakerLinkConfirmations }).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    speakerUnique: uniqueIndex('assistant_speaker_links_speaker_unique').on(
      t.source,
      t.externalNamespace,
      t.externalId,
    ),
    userIdx: index('assistant_speaker_links_user_idx').on(t.userId),
  }),
);

/**
 * A project admin's word that a chat account is a Forge account (ISS-976), for a speaker the chat
 * server cannot match by address. It resolves only in `projectId`, the project whose admin named
 * it, since the authority it lends is the named account's and the admin's reaches no further. It is
 * never a guess: the admin names the account by id and says why. Undoing it keeps the row, with who
 * undid it and why; one naming per speaker and project stands at a time.
 */
export const speakerLinkNamings = pgTable(
  'speaker_link_namings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    source: text('source', { enum: conversationAdapters }).notNull(),
    externalNamespace: text('external_namespace').notNull(),
    externalId: text('external_id').notNull(),
    externalLabel: text('external_label'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    namedBy: uuid('named_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    namedAt: timestamp('named_at', { withTimezone: true }).notNull().defaultNow(),
    undoneBy: uuid('undone_by').references(() => users.id, { onDelete: 'restrict' }),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
    undoReason: text('undo_reason'),
  },
  (t) => ({
    standingUq: uniqueIndex('speaker_link_namings_standing_uq')
      .on(t.projectId, t.source, t.externalNamespace, t.externalId)
      .where(sql`undone_at IS NULL`),
    userIdx: index('speaker_link_namings_user_idx').on(t.userId),
    undoneChk: check(
      'speaker_link_namings_undone_chk',
      sql`(${t.undoneAt} IS NULL) = (${t.undoneBy} IS NULL) AND (${t.undoneAt} IS NULL) = (${t.undoReason} IS NULL)`,
    ),
  }),
);
