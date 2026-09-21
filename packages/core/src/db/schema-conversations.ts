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
import type { PresenceConfig } from './schema-agent-selves.js';

export const conversationAdapters = ['web', 'widget', 'rocketchat', 'telegram'] as const;
export type ConversationAdapter = (typeof conversationAdapters)[number];

export const conversationShapes = ['direct', 'group'] as const;
export type ConversationShape = (typeof conversationShapes)[number];

export const conversationModes = ['assistant', 'agent'] as const;
export type ConversationMode = (typeof conversationModes)[number];

export const conversationMessageRoles = ['user', 'assistant', 'system'] as const;
export type ConversationMessageRole = (typeof conversationMessageRoles)[number];

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

/**
 * What a room may set for itself: the five routing keys and nothing else.
 */
export type RoomPresence = Pick<
  PresenceConfig,
  'dormantMs' | 'backoffAfter' | 'loopBounceMs' | 'loopLimit' | 'answerInGroup'
>;

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adapter: text('adapter', { enum: conversationAdapters }).notNull(),
    externalId: text('external_id').notNull(),
    shape: text('shape', { enum: conversationShapes }).notNull().default('direct'),
    mode: text('mode', { enum: conversationModes }),
    title: text('title'),
    origin: jsonb('origin').$type<ConversationOrigin | null>(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /**
     * This room's own routing thresholds, winning per key over the fold of
     * its handles' selves (ISS-1087).
     */
    presence: jsonb('presence').$type<RoomPresence | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    venueUnique: uniqueIndex('conversations_venue_unique').on(t.adapter, t.externalId),
    updatedIdx: index('conversations_updated_idx').on(t.updatedAt),
    archivedIdx: index('conversations_archived_idx').on(t.archivedAt),
    adapterKnown: check(
      'conversations_adapter_known',
      sql`${t.adapter} IN ('web','widget','rocketchat','telegram')`,
    ),
    shapeKnown: check('conversations_shape_known', sql`${t.shape} IN ('direct','group')`),
    modeKnown: check(
      'conversations_mode_known',
      sql`${t.mode} IS NULL OR ${t.mode} IN ('assistant','agent')`,
    ),
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
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    externalKey: text('external_key'),
    label: text('label'),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
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

export const conversationMessages = pgTable(
  'conversation_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role', { enum: conversationMessageRoles }).notNull(),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    authorLabel: text('author_label'),
    content: text('content').notNull(),
    /**
     * The transport's own id for an inbound message, where it named one.
     */
    externalId: text('external_id'),
    /**
     * The transport's own id for whoever spoke, where it named one.
     */
    authorKey: text('author_key'),
    images: jsonb('images'),
    /**
     * The ordered blocks of the canonical transcript entry this row holds
     * (ISS-1029) — the same `AgentMessage['blocks']` the Claude Code CLI path
     * produces in `lib/agent-stream-parser.ts`.
     */
    blocks: jsonb('blocks'),
    deliveryProof: jsonb('delivery_proof'),
    silenceReason: text('silence_reason'),
    /**
     * The transport's own id for the message this one replies to or quotes,
     * where it named one (ISS-1087).
     */
    replyToExternalId: text('reply_to_external_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    seqUnique: uniqueIndex('conversation_messages_seq_unique').on(t.conversationId, t.seq),
    externalIdx: index('conversation_messages_external_idx')
      .on(t.externalId)
      .where(sql`external_id IS NOT NULL`),
    roleKnown: check(
      'conversation_messages_role_known',
      sql`${t.role} IN ('user','assistant','system')`,
    ),
  }),
);

/**
 * Why a window stopped, in the vocabulary rule 4 of ISS-1004 names.
 */
/** What opened a window: a message that arrived, or a heartbeat tick re-reading a quiet room (ISS-1034). */
export const conversationWindowOrigins = ['inbound', 'heartbeat'] as const;
export type ConversationWindowOrigin = (typeof conversationWindowOrigins)[number];

/**
 * Why a window stopped collecting when it was claimed (ISS-1086).
 */
export const conversationWindowCutReasons = ['quiet', 'deadline', 'overflow'] as const;
export type ConversationWindowCutReason = (typeof conversationWindowCutReasons)[number];

export const conversationWindowDecisions = [
  'answered',
  'nothing-to-say',
  'guard-backoff',
  'guard-agent-loop',
  'guard-dormant',
  'authority-refused',
  'unreachable',
  'undetermined',
  'handed-off',
] as const;
export type ConversationWindowDecision = (typeof conversationWindowDecisions)[number];

/**
 * The unit a routing decision is taken over: the messages that arrived together.
 */
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
    adapter: text('adapter', { enum: conversationAdapters }).notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    extendedAt: timestamp('extended_at', { withTimezone: true }).notNull().defaultNow(),
    firstSeq: integer('first_seq').notNull(),
    lastSeq: integer('last_seq').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /**
     * When this window's reply was handed to the transport.
     */
    deliveryReservedAt: timestamp('delivery_reserved_at', { withTimezone: true }),
    /** Which core holds it — for the log, never for the claim, which is the conditional UPDATE. */
    claimedBy: text('claimed_by'),
    /**
     * Why this window stopped collecting when it was claimed.
     */
    cutReason: text('cut_reason', { enum: conversationWindowCutReasons }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    decision: text('decision', { enum: conversationWindowDecisions }),
    decisionDetail: jsonb('decision_detail'),
    origin: text('origin', { enum: conversationWindowOrigins }).notNull().default('inbound'),
  },
  (t) => ({
    originKnown: check(
      'conversation_windows_origin_known',
      sql`${t.origin} IN ('inbound','heartbeat')`,
    ),
    oneCollecting: uniqueIndex('conversation_windows_one_collecting')
      .on(t.conversationId)
      .where(sql`claimed_at IS NULL AND closed_at IS NULL`),
    dueIdx: index('conversation_windows_due_idx')
      .on(t.adapter, t.extendedAt)
      .where(sql`closed_at IS NULL`),
    holdIdx: index('conversation_windows_hold_idx')
      .on(t.adapter, t.openedAt)
      .where(sql`claimed_at IS NULL`),
    conversationIdx: index('conversation_windows_conversation_idx').on(
      t.conversationId,
      t.closedAt,
    ),
    adapterKnown: check(
      'conversation_windows_adapter_known',
      sql`${t.adapter} IN ('web','widget','rocketchat','telegram')`,
    ),
    cutReasonKnown: check(
      'conversation_windows_cut_reason_known',
      sql`${t.cutReason} IS NULL OR ${t.cutReason} IN ('quiet','deadline','overflow')`,
    ),
    decisionKnown: check(
      'conversation_windows_decision_known',
      sql`${t.decision} IS NULL OR ${t.decision} IN ('answered','nothing-to-say','guard-backoff','guard-agent-loop','guard-dormant','authority-refused','unreachable','undetermined','handed-off')`,
    ),
    closedHasDecision: check(
      'conversation_windows_closed_has_decision',
      sql`(${t.closedAt} IS NULL) = (${t.decision} IS NULL)`,
    ),
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
