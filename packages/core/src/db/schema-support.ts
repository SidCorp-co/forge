// A support group's and an operations room's record (REQ-75), owned by the `support` domain: the
// room and the one session that answers it, every action taken in it, the fixes and filings waiting
// on their asker, and the Feedback the session recorded with the thread it is followed in.

import { FEEDBACK_PHASES } from '@forge/contracts/feedback';
import {
  SUPPORT_ACTION_KINDS,
  SUPPORT_ACTOR_KINDS,
  SUPPORT_FIX_STATES,
  SUPPORT_PROPOSAL_KINDS,
} from '@forge/contracts/support';
import { CHANNEL_MEMBER_STATES, CHANNEL_ROLES } from '@forge/contracts/support-channel';
import { OPERATIONS_SCOPES, SUPPORT_ROOM_KINDS } from '@forge/contracts/support-operations';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
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
 * One room a session answers: a support group (`kind` support, one per binding) or an operations
 * room (`kind` operations, several per binding, each with its `scope`). The `rocketchat` binding that
 * names it, the room, the agent account its session acts as (a member of nothing, like a widget's),
 * and the session that answers it. An operations room's project is the binding's: its home, whose
 * box serves the session.
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
    kind: text('kind', { enum: SUPPORT_ROOM_KINDS }).notNull().default('support'),
    scope: text('scope', { enum: OPERATIONS_SCOPES }),
    principalUserId: uuid('principal_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    sessionId: uuid('session_id').references(() => agentSessions.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bindingRidUq: uniqueIndex('support_rooms_binding_rid_uq').on(t.bindingId, t.rid),
    roomUq: uniqueIndex('support_rooms_connection_rid_uq').on(t.connectionId, t.rid),
    // a channel agent's rooms share one account (REQ-77 BC-1); every other room has its own
    principalUq: uniqueIndex('support_rooms_principal_uq')
      .on(t.principalUserId)
      .where(sql`${t.kind} <> 'agent'`),
    projectIdx: index('support_rooms_project_idx').on(t.projectId),
    kindChk: check('support_rooms_kind_chk', sql`${t.kind} IN (${inList(SUPPORT_ROOM_KINDS)})`),
    scopeChk: check(
      'support_rooms_scope_chk',
      sql`(${t.kind} = 'operations') = (${t.scope} IS NOT NULL) AND (${t.scope} IS NULL OR ${t.scope} IN (${inList(OPERATIONS_SCOPES)}))`,
    ),
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
    proposalId: uuid('proposal_id'),
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
    // one result per firing of a scheduled check (REQ-77 BC-13), whichever turn sends it
    checkResultUq: uniqueIndex('support_actions_check_result_uq')
      .on(t.roomId, t.thread)
      .where(sql`kind = 'check_result'`),
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
 * A change the session proposed, waiting on the one account that asked, or what became of it: a
 * `fix` through the product API (its `tool`), or a Feedback `filing` (no tool, `support/propose.ts`).
 */
export const supportProposals = pgTable(
  'support_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => supportRooms.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    thread: text('thread').notNull(),
    kind: text('kind', { enum: SUPPORT_PROPOSAL_KINDS }).notNull().default('fix'),
    tool: text('tool'),
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
    pendingCodeUq: uniqueIndex('support_proposals_pending_code_uq')
      .on(t.roomId, t.code)
      .where(sql`state = 'pending'`),
    stateChk: check(
      'support_proposals_state_chk',
      sql`${t.state} IN (${inList(SUPPORT_FIX_STATES)})`,
    ),
    codeChk: check('support_proposals_code_chk', sql`${t.code} ~ '^[A-HJ-NP-Z2-9]{6}$'`),
    decidedChk: check(
      'support_proposals_decided_chk',
      sql`(${t.state} = 'pending') = (${t.decidedAt} IS NULL)`,
    ),
    expiryChk: check('support_proposals_expiry_chk', sql`${t.expiresAt} > ${t.createdAt}`),
    kindChk: check(
      'support_proposals_kind_chk',
      sql`${t.kind} IN (${inList(SUPPORT_PROPOSAL_KINDS)}) AND (${t.kind} = 'fix') = (${t.tool} IS NOT NULL)`,
    ),
  }),
);

/**
 * A Feedback item the session recorded, and the thread its result is told in once it is final
 * (REQ-75 r6 BC-15). `last_phase` is the phase it was last read at; nothing is posted for one.
 */
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
    /** The phase the item was last read at. */
    lastPhase: text('last_phase', { enum: FEEDBACK_PHASES }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when its result was told (it shipped, was confirmed or was declined): nothing more is. */
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

/**
 * A bound group's channel record (REQ-75 r6 BC-41): one per project and group, read by every room
 * row of that project bound to the group, whichever bot answers it.
 */
export const supportChannels = pgTable(
  'support_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    rid: text('rid').notNull(),
    // the agent outside Forge answering the group, as it last declared itself (REQ-75 r7 BC-42)
    agentRole: text('agent_role'),
    agentBox: text('agent_box'),
    agentAddress: text('agent_address'),
    agentDeclaredAt: timestamp('agent_declared_at', { withTimezone: true }),
    agentDeclaredBy: uuid('agent_declared_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectRidUq: uniqueIndex('support_channels_project_rid_uq').on(t.projectId, t.rid),
  }),
);

/**
 * A member of a channel by Rocket.Chat username (BC-31..BC-34): the roles the bot inferred or a
 * person confirmed, and what to ask them for. No email or other personal data (BC-40).
 */
export const supportChannelMembers = pgTable(
  'support_channel_members',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => supportChannels.id, { onDelete: 'cascade' }),
    username: text('username').notNull(),
    roles: text('roles').array().notNull(),
    askFor: text('ask_for'),
    state: text('state', { enum: CHANNEL_MEMBER_STATES }).notNull(),
    confirmedBy: uuid('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
    /** The message the bot read its inference from. */
    sourceMessage: text('source_message'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ name: 'support_channel_members_pk', columns: [t.channelId, t.username] }),
    rolesChk: check(
      'support_channel_members_roles_chk',
      sql`cardinality(${t.roles}) >= 1 AND ${t.roles} <@ ARRAY[${inList(CHANNEL_ROLES)}]::text[]`,
    ),
    stateChk: check(
      'support_channel_members_state_chk',
      sql`${t.state} IN (${inList(CHANNEL_MEMBER_STATES)})`,
    ),
  }),
);

/**
 * A channel rule (BC-35): an instruction a team member gave, linked to the message it came from, or a
 * rule a person added in Forge (no message). A removed rule keeps its row.
 */
export const supportChannelRules = pgTable(
  'support_channel_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => supportChannels.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    author: text('author'),
    messageId: text('message_id'),
    thread: text('thread'),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (t) => ({
    messageUq: uniqueIndex('support_channel_rules_message_uq')
      .on(t.channelId, t.messageId)
      .where(sql`removed_at IS NULL AND message_id IS NOT NULL`),
    sourceChk: check(
      'support_channel_rules_source_chk',
      sql`(${t.messageId} IS NULL) = (${t.author} IS NULL) AND (${t.messageId} IS NULL) = (${t.thread} IS NULL)`,
    ),
  }),
);

/** A question asked in several threads, with its one answer (BC-36); a defect links its Feedback. */
export const supportChannelCommonIssues = pgTable(
  'support_channel_common_issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => supportChannels.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    /** The question folded to lower case and single spaces: one common issue per question. */
    questionKey: text('question_key').notNull(),
    answer: text('answer').notNull(),
    threads: text('threads').array().notNull(),
    feedbackId: uuid('feedback_id').references(() => feedback.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (t) => ({
    questionUq: uniqueIndex('support_channel_common_issues_question_uq')
      .on(t.channelId, t.questionKey)
      .where(sql`removed_at IS NULL`),
    threadsChk: check(
      'support_channel_common_issues_threads_chk',
      sql`cardinality(${t.threads}) >= 2`,
    ),
  }),
);

/**
 * A group's switch from the bot outside Forge that answers it to the project's channel agent (REQ-77
 * BC-16..BC-19): the outside bot's chat account the switch removes from the group, the duties the
 * agent passes first (each by a person, with what they saw), the earlier switch it waits on until
 * that one is proven, and the owner's word where it is needed. `applying_at` is set while the switch
 * runs, the one moment the binding door lets the group join the agent.
 */
export const supportChannelSwitches = pgTable(
  'support_channel_switches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    rid: text('rid').notNull(),
    outsideBotUserId: text('outside_bot_user_id').notNull(),
    outsideBotUsername: text('outside_bot_username'),
    /** The outside bot answers as the binding's own chat account: the switch removes nobody. */
    outsideIsSelf: boolean('outside_is_self').notNull().default(false),
    /** An operator's record that the outside bot's process is stopped, which a self switch waits on. */
    outsideStoppedAt: timestamp('outside_stopped_at', { withTimezone: true }),
    outsideStoppedBy: uuid('outside_stopped_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    outsideStoppedNote: text('outside_stopped_note'),
    /** `[{ key, text, passedBy, passedAt, evidence }]`, in the order the plan named them. */
    duties: jsonb('duties').notNull(),
    afterSwitchId: uuid('after_switch_id'),
    ownerWordNeeded: boolean('owner_word_needed').notNull().default(false),
    ownerWord: text('owner_word'),
    ownerWordBy: uuid('owner_word_by').references(() => users.id, { onDelete: 'set null' }),
    ownerWordAt: timestamp('owner_word_at', { withTimezone: true }),
    applyingAt: timestamp('applying_at', { withTimezone: true }),
    switchedAt: timestamp('switched_at', { withTimezone: true }),
    switchedBy: uuid('switched_by').references(() => users.id, { onDelete: 'set null' }),
    provenAt: timestamp('proven_at', { withTimezone: true }),
    provenBy: uuid('proven_by').references(() => users.id, { onDelete: 'set null' }),
    provenNote: text('proven_note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectRidUq: uniqueIndex('support_channel_switches_project_rid_uq').on(t.projectId, t.rid),
    afterFk: foreignKey({
      columns: [t.afterSwitchId],
      foreignColumns: [t.id],
      name: 'support_channel_switches_after_fk',
    }).onDelete('restrict'),
    notSelfChk: check(
      'support_channel_switches_not_self_chk',
      sql`${t.afterSwitchId} IS NULL OR ${t.afterSwitchId} <> ${t.id}`,
    ),
  }),
);
