// A support group's record (REQ-75), owned by the `support` domain: the room and the one session
// that answers it, every action taken in it, the fixes waiting on their asker, and the Feedback the
// session recorded with the thread it is followed in.

import { FEEDBACK_PHASES } from '@forge/contracts/feedback';
import {
  SUPPORT_ACTION_KINDS,
  SUPPORT_ACTOR_KINDS,
  SUPPORT_FIX_STATES,
} from '@forge/contracts/support';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agentSessions } from './schema-agent-sessions.js';
import { users } from './schema-auth.js';
import { conversations } from './schema-conversations.js';
import { feedback } from './schema-feedback.js';
import { integrationBindings } from './schema-project-config.js';
import { projects } from './schema-projects.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * One support group: the `rocketchat` binding that names it, the room, the agent account its
 * session acts as (a member of nothing, like a widget's), and the session that answers it.
 */
export const supportRooms = pgTable(
  'support_rooms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    bindingId: uuid('binding_id')
      .notNull()
      .references(() => integrationBindings.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id').notNull(),
    rid: text('rid').notNull(),
    principalUserId: uuid('principal_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    sessionId: uuid('session_id').references(() => agentSessions.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bindingUq: uniqueIndex('support_rooms_binding_uq').on(t.bindingId),
    roomUq: uniqueIndex('support_rooms_connection_rid_uq').on(t.connectionId, t.rid),
    principalUq: uniqueIndex('support_rooms_principal_uq').on(t.principalUserId),
    projectIdx: index('support_rooms_project_idx').on(t.projectId),
  }),
);

/**
 * Every action in a support group, insert-only but for `delivered_at`, which a `message_in` row
 * takes when a turn hands it to the session. Inputs and outputs are stored scrubbed.
 */
export const supportActions = pgTable(
  'support_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => supportRooms.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    thread: text('thread').notNull(),
    kind: text('kind', { enum: SUPPORT_ACTION_KINDS }).notNull(),
    actorKind: text('actor_kind', { enum: SUPPORT_ACTOR_KINDS }).notNull(),
    /** The Rocket.Chat account id for a member's act; null for the session's and core's. */
    actorKey: text('actor_key'),
    actorLabel: text('actor_label'),
    tool: text('tool'),
    input: jsonb('input'),
    output: jsonb('output'),
    /** The Rocket.Chat message this action is: the inbound message, or the line posted. */
    externalId: text('external_id'),
    fixId: uuid('fix_id'),
    feedbackId: uuid('feedback_id').references(() => feedback.id, { onDelete: 'set null' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    roomCreatedIdx: index('support_actions_room_created_idx').on(t.roomId, t.createdAt),
    undeliveredIdx: index('support_actions_undelivered_idx')
      .on(t.roomId, t.createdAt)
      .where(sql`kind = 'message_in' AND delivered_at IS NULL`),
    inboundUq: uniqueIndex('support_actions_inbound_uq')
      .on(t.roomId, t.externalId)
      .where(sql`kind = 'message_in'`),
    kindChk: check('support_actions_kind_chk', sql`${t.kind} IN (${inList(SUPPORT_ACTION_KINDS)})`),
    actorChk: check(
      'support_actions_actor_chk',
      sql`${t.actorKind} IN (${inList(SUPPORT_ACTOR_KINDS)}) AND (${t.actorKind} = 'member') = (${t.actorKey} IS NOT NULL)`,
    ),
    deliveredChk: check(
      'support_actions_delivered_chk',
      sql`${t.deliveredAt} IS NULL OR ${t.kind} = 'message_in'`,
    ),
  }),
);

/**
 * A change the session proposed, waiting on the one account that asked, or what became of it: a fix
 * through the product API, or a Feedback filing (tool `forge:record`, `support/propose.ts`).
 */
export const supportFixes = pgTable(
  'support_fixes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => supportRooms.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    thread: text('thread').notNull(),
    tool: text('tool').notNull(),
    args: jsonb('args').notNull().default({}),
    askerKey: text('asker_key').notNull(),
    askerLabel: text('asker_label'),
    code: text('code').notNull(),
    state: text('state', { enum: SUPPORT_FIX_STATES }).notNull().default('pending'),
    result: jsonb('result'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => ({
    pendingCodeUq: uniqueIndex('support_fixes_pending_code_uq')
      .on(t.roomId, t.code)
      .where(sql`state = 'pending'`),
    stateChk: check('support_fixes_state_chk', sql`${t.state} IN (${inList(SUPPORT_FIX_STATES)})`),
    codeChk: check('support_fixes_code_chk', sql`${t.code} ~ '^[A-HJ-NP-Z2-9]{6}$'`),
    decidedChk: check(
      'support_fixes_decided_chk',
      sql`(${t.state} = 'pending') = (${t.decidedAt} IS NULL)`,
    ),
    expiryChk: check('support_fixes_expiry_chk', sql`${t.expiresAt} > ${t.createdAt}`),
  }),
);

/** A Feedback item the session recorded, and the thread its progress is posted in until it ships. */
export const supportFeedbackLinks = pgTable(
  'support_feedback_links',
  {
    feedbackId: uuid('feedback_id')
      .primaryKey()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    roomId: uuid('room_id')
      .notNull()
      .references(() => supportRooms.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    thread: text('thread').notNull(),
    /** The phase last posted in the thread. */
    lastPhase: text('last_phase', { enum: FEEDBACK_PHASES }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when the item shipped or was declined: nothing more is posted. */
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => ({
    openIdx: index('support_feedback_links_open_idx').on(t.projectId).where(sql`closed_at IS NULL`),
    phaseChk: check(
      'support_feedback_links_phase_chk',
      sql`${t.lastPhase} IN (${inList(FEEDBACK_PHASES)})`,
    ),
  }),
);
