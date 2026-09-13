// The durable conversation: a room that outlives every session that ever spoke
// in it, addressed by its transport and that transport's own id for it.
//
// It replaces `chat_sessions`, which was a project plus a jsonb blob rewritten
// wholesale on every turn, and whose room-to-row mapping lived only in a
// Rocket.Chat connection manager's in-process Map.
//
// Split out of `schema.ts` for size, like `schema-questions.ts`, and registered
// in `drizzle.config.ts` and the client's schema map beside it.

import { relations, sql } from 'drizzle-orm';
import {
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
import { users } from './schema.js';

// cm:guard the transports a conversation can belong to, and the same list `assistant_speaker_links.source` is an authority over — a speaker linked under a source is linked for that transport alone. Renamed from `chatSessionSources` when the table it was named after was replaced (ISS-1001); adding a member here without an adapter registered in `conversations/ports.ts` gives a venue nothing can deliver to.
export const conversationAdapters = ['web', 'widget', 'rocketchat', 'telegram'] as const;
export type ConversationAdapter = (typeof conversationAdapters)[number];

// cm:guard `direct` and `group` are the SAME code path at N=1 and N>=2 and neither is a special case: a direct room is one handle, a group room is several, and what a shape decides is addressing, never scope. Scope comes from the participants in every case.
export const conversationShapes = ['direct', 'group'] as const;
export type ConversationShape = (typeof conversationShapes)[number];

export const conversationMessageRoles = ['user', 'assistant', 'system'] as const;
export type ConversationMessageRole = (typeof conversationMessageRoles)[number];

// cm:guard a `handle` participant MUST carry a `user_id` and that user must be `kind='agent'`: the room's scope is the union of its handles' project memberships, so a handle with no user contributes no scope and makes the room unreadable. A `person` may carry no user — widget traffic and an unlinked channel speaker have only the key the transport gave.
export const conversationParticipantKinds = ['person', 'handle'] as const;
export type ConversationParticipantKind = (typeof conversationParticipantKinds)[number];

/** What a `chat_sessions` row held, kept so the reverse migration needs no membership lookup. */
export interface ConversationOrigin {
  chatSessionId: string;
  projectId: string;
  userId: string | null;
  userKey: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
  /** The handle 0241 minted for this project, or null where an existing agent account was reused. */
  mintedHandleUserId: string | null;
}

// cm:guard NO project column, ever: a room's projects are the union of its handle participants' memberships, read at the moment of the read, and a column here is a second copy of that which a revoked role does not reach. The column is what made `chat_sessions` a project's thing rather than a conversation (ISS-1001).
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adapter: text('adapter', { enum: conversationAdapters }).notNull(),
    // cm:guard the transport's OWN id for the venue, unique within that transport only — for Rocket.Chat the rid, or `<rid> <tmid>` for a thread, which is why the pair and never `external_id` alone is the unique index.
    externalId: text('external_id').notNull(),
    shape: text('shape', { enum: conversationShapes }).notNull().default('direct'),
    title: text('title'),
    // cm:guard provenance for the reverse migration and NOTHING else — scope may never be read from it, and a reader that took `origin.projectId` for the room's project would restore the column this table exists to remove. Null on every conversation opened after 0241 ran.
    origin: jsonb('origin').$type<ConversationOrigin | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // cm:guard every CHECK the migration creates is declared HERE too, because a drizzle snapshot
  // records `checkConstraints` per table: one left in SQL alone is a constraint the snapshot denies
  (t) => ({
    venueUnique: uniqueIndex('conversations_venue_unique').on(t.adapter, t.externalId),
    updatedIdx: index('conversations_updated_idx').on(t.updatedAt),
    adapterKnown: check(
      'conversations_adapter_known',
      sql`${t.adapter} IN ('web','widget','rocketchat','telegram')`,
    ),
    shapeKnown: check('conversations_shape_known', sql`${t.shape} IN ('direct','group')`),
  }),
);

export const conversationParticipants = pgTable(
  'conversation_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: conversationParticipantKinds }).notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    // cm:guard the transport's own key for a speaker with no Forge user — the audit key `chat_sessions.user_key` carried. It is NOT an identity: nothing authorizes on it, and `assistant_speaker_links` stays the only path from a channel speaker to a `userId`.
    externalKey: text('external_key'),
    label: text('label'),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    // cm:guard a removal is a stamp and never a DELETE: a message row names its author, and deleting the participant row would leave a transcript whose speakers cannot be listed back.
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (t) => ({
    liveUserUnique: uniqueIndex('conversation_participants_live_user_unique')
      .on(t.conversationId, t.userId)
      .where(sql`removed_at IS NULL AND user_id IS NOT NULL`),
    conversationIdx: index('conversation_participants_conversation_idx').on(t.conversationId),
    userIdx: index('conversation_participants_user_idx').on(t.userId),
    kindKnown: check('conversation_participants_kind_known', sql`${t.kind} IN ('person','handle')`),
    handleHasUser: check(
      'conversation_participants_handle_has_user',
      sql`${t.kind} <> 'handle' OR ${t.userId} IS NOT NULL`,
    ),
    personIdentified: check(
      'conversation_participants_person_identified',
      sql`${t.kind} <> 'person' OR ${t.userId} IS NOT NULL OR ${t.externalKey} IS NOT NULL`,
    ),
  }),
);

// cm:guard one ROW per message, never an element of a jsonb array: `chat_sessions.messages` was rewritten whole on every turn, so turn 201 deleted turn 1 and a concurrent turn lost the other's write. The precedent is `agent_session_turns`, and the reason is the same one it was created for.
export const conversationMessages = pgTable(
  'conversation_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    // cm:guard allocated inside the INSERT off the current max, never read-then-written by the caller: two turns that both read N and both write N+1 lose one message, which is the loss the jsonb blob had and the unique index below is what refuses it.
    seq: integer('seq').notNull(),
    role: text('role', { enum: conversationMessageRoles }).notNull(),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    // cm:guard the name the transport gave a speaker nothing has linked, kept for the reader and never for authorization — a row with a null `author_user_id` is a message by nobody Forge knows, which is a fact and not a gap to fill.
    authorLabel: text('author_label'),
    content: text('content').notNull(),
    images: jsonb('images'),
    // cm:guard the receipt the adapter's own `deliver` returned, and a chip may claim only what it holds: a null here means the transport took the text without naming a message, which is NOT delivered (ISS-1001 invariant 8).
    deliveryProof: jsonb('delivery_proof'),
    // cm:guard why a turn said nothing, written INSTEAD of the text — a silence with no row is indistinguishable from a turn that never ran, which is the state invariant 7 exists to remove.
    silenceReason: text('silence_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    seqUnique: uniqueIndex('conversation_messages_seq_unique').on(t.conversationId, t.seq),
    roleKnown: check(
      'conversation_messages_role_known',
      sql`${t.role} IN ('user','assistant','system')`,
    ),
  }),
);

export const conversationsRelations = relations(conversations, ({ many }) => ({
  participants: many(conversationParticipants),
  messages: many(conversationMessages),
}));

export const conversationParticipantsRelations = relations(conversationParticipants, ({ one }) => ({
  conversation: one(conversations, {
    fields: [conversationParticipants.conversationId],
    references: [conversations.id],
  }),
  user: one(users, { fields: [conversationParticipants.userId], references: [users.id] }),
}));

export const conversationMessagesRelations = relations(conversationMessages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [conversationMessages.conversationId],
    references: [conversations.id],
  }),
  author: one(users, { fields: [conversationMessages.authorUserId], references: [users.id] }),
}));
