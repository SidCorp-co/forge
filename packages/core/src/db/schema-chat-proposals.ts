import {
  CHAT_AGREEMENT_VIAS,
  CHAT_PROPOSAL_FORMS,
  CHAT_PROPOSAL_KINDS,
  CHAT_PROPOSAL_STATUSES,
} from '@forge/contracts/chat-proposals';
import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { agentSessions } from './schema-agent-sessions.js';
import { users } from './schema-auth.js';
import { conversations } from './schema-conversations.js';
import { projects } from './schema-projects.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * A chat's write held until the person it answers agrees (REQ-30 BC-4), owned by the `assistant`
 * domain. `call` is exactly what was held: an Assistant tool call `{ name, arguments }`, or an Agent
 * session's REST request `{ method, path, contentType }` with its bytes in `body`. Nothing here is
 * ever rewritten but the decision: who decided, how, and what the write made or why it was refused.
 */
export const chatProposals = pgTable(
  'chat_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** The person whose agreement it waits on: the one the proposing turn answered. */
    proposedTo: uuid('proposed_to')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The handle that answered, stamped on a note the write makes. */
    handleUserId: uuid('handle_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** The Agent session whose REST request was held; null for an Assistant turn's call. */
    sessionId: uuid('session_id').references(() => agentSessions.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: CHAT_PROPOSAL_KINDS }).notNull(),
    form: text('form', { enum: CHAT_PROPOSAL_FORMS }).notNull(),
    call: jsonb('call').notNull(),
    body: bytea('body'),
    summary: jsonb('summary').notNull(),
    status: text('status', { enum: CHAT_PROPOSAL_STATUSES }).notNull().default('pending'),
    agreedVia: text('agreed_via', { enum: CHAT_AGREEMENT_VIAS }),
    agreedWords: text('agreed_words'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    record: jsonb('record'),
    failure: text('failure'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    conversationIdx: index('chat_proposals_conversation_idx').on(t.conversationId, t.createdAt),
    proposedToIdx: index('chat_proposals_proposed_to_idx').on(t.proposedTo),
    kindChk: check('chat_proposals_kind_chk', sql`${t.kind} IN (${inList(CHAT_PROPOSAL_KINDS)})`),
    formChk: check('chat_proposals_form_chk', sql`${t.form} IN (${inList(CHAT_PROPOSAL_FORMS)})`),
    statusChk: check(
      'chat_proposals_status_chk',
      sql`${t.status} IN (${inList(CHAT_PROPOSAL_STATUSES)})`,
    ),
    viaChk: check(
      'chat_proposals_agreed_via_chk',
      sql`${t.agreedVia} IS NULL OR ${t.agreedVia} IN (${inList(CHAT_AGREEMENT_VIAS)})`,
    ),
    bodyChk: check('chat_proposals_body_chk', sql`${t.form} = 'rest' OR ${t.body} IS NULL`),
    decidedChk: check(
      'chat_proposals_decided_chk',
      sql`(${t.status} = 'pending') = (${t.decidedAt} IS NULL)`,
    ),
    agreedChk: check(
      'chat_proposals_agreed_chk',
      sql`(${t.status} IN ('agreed', 'recorded', 'failed')) = (${t.agreedVia} IS NOT NULL)`,
    ),
  }),
);

export type ChatProposalRow = typeof chatProposals.$inferSelect;
