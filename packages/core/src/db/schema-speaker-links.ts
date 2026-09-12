// The map from a chat-channel speaker to a Forge user — the one thing that lets
// a reply typed in a room be an authorized act rather than a label.
//
// Split out of `schema.ts` only for size; it is a schema module like
// `schema-session-inbox.ts` and is registered in `drizzle.config.ts` and the
// drizzle client's schema map alongside it.

import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { chatSessionSources, users } from './schema.js';

// cm:guard one value today, and a second one is a NEW authority rather than a relabelling of this one. `channel_email_match` means the channel's own directory reported this user's exact address and the person holding that Forge account asked for the link themselves; a delegated path (an account-linking admin, a redeemed pairing code) states a different thing and must be told apart from this one wherever authority is read back.
export const speakerLinkConfirmations = ['channel_email_match'] as const;
export type SpeakerLinkConfirmation = (typeof speakerLinkConfirmations)[number];

export const assistantSpeakerLinks = pgTable(
  'assistant_speaker_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source', { enum: chatSessionSources }).notNull(),
    // cm:guard the channel INSTANCE, not the channel type — a Rocket.Chat user id is unique only within one installation, so without this column a confirmed row on one server answers for a stranger of the same id on another. Derived from the connection, never from request input (`assistant/identity/directory.ts`).
    externalNamespace: text('external_namespace').notNull(),
    // cm:guard the channel's own stable user id and never a display name. A username is re-assignable on most chat servers, so a mapping keyed on one hands the next holder of that name the previous holder's authority.
    externalId: text('external_id').notNull(),
    // cm:guard refusal text only — nothing may read this to decide anything, or the re-assignable name is a key again by the back door
    externalLabel: text('external_label'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    confirmedVia: text('confirmed_via', { enum: speakerLinkConfirmations }).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // cm:guard a row here IS the authorization — there is no status column and no disabled state, so every row present is confirmed and unlinking DELETES. A soft-delete flag would make "is this speaker linked" two questions, and the one a caller forgets is the one that authorizes.
    speakerUnique: uniqueIndex('assistant_speaker_links_speaker_unique').on(
      t.source,
      t.externalNamespace,
      t.externalId,
    ),
    userIdx: index('assistant_speaker_links_user_idx').on(t.userId),
  }),
);
