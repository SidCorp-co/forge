import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { projects } from './schema-projects.js';
import { conversationAdapters } from './schema-vocabulary.js';

/**
 * How a link was confirmed: the chat server reported the person's Forge address, or the person,
 * signed in to Forge, minted a code and wrote it in a bound room from the chat account itself.
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
 * A one-time code a signed-in Forge user minted to link a chat account to themselves (REQ-75 r5):
 * written in a room bound to `projectId` from that account, it confirms the link, since the chat
 * server signs who wrote it. Only its hash is kept; it is spent once and lapses at `expiresAt`.
 */
export const speakerLinkCodes = pgTable(
  'speaker_link_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    codeHash: text('code_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    source: text('source', { enum: conversationAdapters }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => ({
    codeUnique: uniqueIndex('speaker_link_codes_code_unique').on(t.codeHash),
    userIdx: index('speaker_link_codes_user_idx').on(t.userId),
  }),
);
