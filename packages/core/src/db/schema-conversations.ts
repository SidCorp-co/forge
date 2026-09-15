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
import { projects, users } from './schema.js';

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
  /** The title AS CONSUMED; the conversation's own column carries any rename made since. */
  title: string | null;
  source: string;
  /** The consumed transcript VERBATIM — what makes the reverse exact rather than equivalent. */
  messages: unknown;
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
    // cm:guard a soft archive that DESTROYS nothing: it takes the room out of the default list and
    // out of its count, and every message it holds is still readable by id. A list that hid a room
    // with no way back would be the delete this column exists to avoid (ISS-1028).
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // cm:guard every CHECK the migration creates is declared HERE too, because a drizzle snapshot records `checkConstraints` per table: one left in SQL alone is a constraint the snapshot denies
  (t) => ({
    venueUnique: uniqueIndex('conversations_venue_unique').on(t.adapter, t.externalId),
    updatedIdx: index('conversations_updated_idx').on(t.updatedAt),
    archivedIdx: index('conversations_archived_idx').on(t.archivedAt),
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
    /**
     * The project this handle was added FOR — the room's scope, recorded
     * (ISS-1003).
     */
    // cm:guard this is NOT the second copy of a membership the `derivedScope` guard refuses, and the difference is what it answers: `project_members` says what the agent may DO and is deleted by a revoke, while this says what the ROOM is about and a revoke must not touch it. Reading scope off the authority table is what made revoking an agent leave a room nobody could read and nobody could repair. It is written by the caller that names the project, never derived from the agent's memberships at write time — an agent given a second membership later must not widen a room it already sits in.
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
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
    projectIdx: index('conversation_participants_project_idx').on(t.projectId),
    kindKnown: check('conversation_participants_kind_known', sql`${t.kind} IN ('person','handle')`),
    // cm:guard a REMOVED handle is admitted with a null: it is in no scope, so there is nothing to record, and a value invented from today's memberships would date the row wrong.
    handleHasProject: check(
      'conversation_participants_handle_has_project',
      sql`${t.kind} <> 'handle' OR ${t.removedAt} IS NOT NULL OR ${t.projectId} IS NOT NULL`,
    ),
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
    /**
     * The transport's own id for an inbound message, where it named one.
     */
    // cm:guard the one thing a collected row loses otherwise: the window routes long after the message arrived, so without this there is no way to tell the room's own history reader which lines it has already been given, and the model is shown the same messages twice — once as seed context and once as its own transcript. Null for anything this codebase wrote (ISS-1004).
    externalId: text('external_id'),
    /**
     * The transport's own id for whoever spoke, where it named one.
     */
    // cm:guard kept so a window routed minutes later can still say who is being refused: the authority refusal is taken at ROUTE time, and without this the only speaker the row remembers is a display label, which no directory can be asked about. Null for anything this codebase wrote (ISS-1004).
    authorKey: text('author_key'),
    images: jsonb('images'),
    /**
     * The ordered blocks of the canonical transcript entry this row holds
     * (ISS-1029) — the same `AgentMessage['blocks']` the Claude Code CLI path
     * produces in `lib/agent-stream-parser.ts`.
     */
    // cm:guard NULL here is a legacy flat row and NOT a gap to fill: every row written before
    // ISS-1029, and every row an adapter writes through the text-only door, carries its whole
    // answer in `content`, and `toCanonicalEntry` reads one back as a single text block. A reader
    // that treated null as "no blocks yet" would show an empty turn where a real answer is stored.
    // cm:guard `content` is NOT derived from these and stays the final text on its own: it is what
    // `toProviderMessages` replays to the model and what every preview reads, and deriving it here
    // would put the same sentence in two columns that nothing keeps in step.
    blocks: jsonb('blocks'),
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

/**
 * Why a window stopped, in the vocabulary rule 4 of ISS-1004 names.
 */
// cm:guard the five silences are told APART and are not one `silent`: a person asking why nothing was said is owed the difference between nobody having anything to add, a guard pacing the room, authority refusing, an agent that could not be reached, and an outcome nobody knows yet. Collapsing them is the unreadable silence ISS-1004 exists to remove.
// cm:guard `undetermined` is NOT a failure and no caller may act on it as one: the reply may still arrive by the path the turn was handed to, and re-routing the window on it is how one answer becomes two (ISS-1004 rule 4).
/** What opened a window: a message that arrived, or a heartbeat tick re-reading a quiet room (ISS-1034). */
export const conversationWindowOrigins = ['inbound', 'heartbeat'] as const;
export type ConversationWindowOrigin = (typeof conversationWindowOrigins)[number];

export const conversationWindowDecisions = [
  'answered',
  'nothing-to-say',
  'guard-backoff',
  'guard-agent-loop',
  'guard-dormant',
  'authority-refused',
  'unreachable',
  'undetermined',
] as const;
export type ConversationWindowDecision = (typeof conversationWindowDecisions)[number];

/**
 * The unit a routing decision is taken over: the messages that arrived together.
 */
// cm:guard a ROW and not a timer in a process: a window living only in memory is a silence with no owner when the core restarts, and the messages inside it are never routed and never noticed. The row is what a restart finds and what a second core is refused (ISS-1004 rule 1).
export const conversationWindows = pgTable(
  'conversation_windows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** The project whose handle answers in this window — the venue's binding, not the room's scope. */
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // cm:guard carried on the window rather than joined off the conversation so a drain loop asks for ITS OWN adapter's work in one index scan: a loop that read every open window and then filtered would claim windows for a transport it cannot deliver through.
    adapter: text('adapter', { enum: conversationAdapters }).notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    // cm:guard the SETTLE clock, moved by every later message: a window closes on quiet rather than on a count, so two messages typed seconds apart are one decision and one cost.
    extendedAt: timestamp('extended_at', { withTimezone: true }).notNull().defaultNow(),
    firstSeq: integer('first_seq').notNull(),
    lastSeq: integer('last_seq').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /**
     * When this window's reply was handed to the transport.
     */
    // cm:guard stamped BEFORE the send and never after it, which is the only order that makes at-most-once true across a crash: a core that posts a reply and dies before recording it leaves this stamp and no delivered row, and the next claimant reads that pair as "a delivery was started and nobody knows how it ended" — which is `undetermined`, not a second attempt. Recording it after the send would make the commonest loss look like a delivery that never happened (ISS-1004 rule 2).
    deliveryReservedAt: timestamp('delivery_reserved_at', { withTimezone: true }),
    /** Which core holds it — for the log, never for the claim, which is the conditional UPDATE. */
    claimedBy: text('claimed_by'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    decision: text('decision', { enum: conversationWindowDecisions }),
    decisionDetail: jsonb('decision_detail'),
    // cm:guard a heartbeat window is told apart by THIS column and never by its message range: a heartbeat re-reads messages an inbound window already routed, so the two ranges overlap by design, and the eligibility rule ("no heartbeat window newer than the interval") has to find the last heartbeat by what it was rather than by what it held (ISS-1034).
    origin: text('origin', { enum: conversationWindowOrigins }).notNull().default('inbound'),
  },
  (t) => ({
    originKnown: check(
      'conversation_windows_origin_known',
      sql`${t.origin} IN ('inbound','heartbeat')`,
    ),
    // cm:guard ONE COLLECTING window per conversation, as a database fact rather than a convention: without it two messages seconds apart become two decisions and two costs. The predicate is `claimed_at IS NULL` and NOT `closed_at IS NULL` on purpose — a window being routed has already snapshotted its messages, so a message arriving mid-route must open the SUCCESSOR rather than join a turn that will never read it or collide with an index (ISS-1004 rule 1).
    oneCollecting: uniqueIndex('conversation_windows_one_collecting')
      .on(t.conversationId)
      .where(sql`claimed_at IS NULL AND closed_at IS NULL`),
    dueIdx: index('conversation_windows_due_idx')
      .on(t.adapter, t.extendedAt)
      .where(sql`closed_at IS NULL`),
    conversationIdx: index('conversation_windows_conversation_idx').on(
      t.conversationId,
      t.closedAt,
    ),
    // cm:guard every enum column in this file carries its CHECK, for the reason the header gives: the drizzle snapshot records `checkConstraints` per table, and a column typed in TypeScript alone is a value the database will take from anything that writes to it by hand.
    adapterKnown: check(
      'conversation_windows_adapter_known',
      sql`${t.adapter} IN ('web','widget','rocketchat','telegram')`,
    ),
    decisionKnown: check(
      'conversation_windows_decision_known',
      sql`${t.decision} IS NULL OR ${t.decision} IN ('answered','nothing-to-say','guard-backoff','guard-agent-loop','guard-dormant','authority-refused','unreachable','undetermined')`,
    ),
    // cm:guard a closed window ALWAYS carries its decision and an open one never does: a close with no decision is the unreadable silence this table was added to make impossible, and the constraint is what stops a caller inventing a third state.
    closedHasDecision: check(
      'conversation_windows_closed_has_decision',
      sql`(${t.closedAt} IS NULL) = (${t.decision} IS NULL)`,
    ),
    // cm:guard claimed BEFORE it routes, and a close is a route: an unclaimed close is a decision two cores could both have taken (ISS-1004 rule 1).
    closedWasClaimed: check(
      'conversation_windows_closed_was_claimed',
      sql`${t.closedAt} IS NULL OR ${t.claimedAt} IS NOT NULL`,
    ),
    seqOrder: check('conversation_windows_seq_order', sql`${t.lastSeq} >= ${t.firstSeq}`),
  }),
);

export const conversationsRelations = relations(conversations, ({ many }) => ({
  participants: many(conversationParticipants),
  messages: many(conversationMessages),
  windows: many(conversationWindows),
}));

export const conversationWindowsRelations = relations(conversationWindows, ({ one }) => ({
  conversation: one(conversations, {
    fields: [conversationWindows.conversationId],
    references: [conversations.id],
  }),
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
