// The map from a chat-channel speaker to a Forge user — the one thing that lets
// a reply typed in a room be an authorized act rather than a label.
//
// Split out of `schema.ts` only for size; it is a schema module like
// `schema-session-inbox.ts` and is registered in `drizzle.config.ts` and the
// drizzle client's schema map alongside it.

import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema.js';
import { conversationAdapters } from './schema-conversations.js';

export const speakerLinkConfirmations = ['channel_email_match'] as const;
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
