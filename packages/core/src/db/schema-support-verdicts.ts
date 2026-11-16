// ISS-1250 (owner, 2026-11-16), owned by the `support` domain beside its rooms (`schema-support.ts`),
// kept apart only for size: a room agent's audit of its own reply, and since ISS-1251 every other
// agent's audit of its own output, one verdict store the capabilities page counts misses from.

import { SUPPORT_ROOM_KINDS } from '@forge/contracts/support-operations';
import {
  REPLY_VERDICTS,
  SELF_AUDIT_OUTPUT_KINDS,
  SELF_AUDIT_ROLES,
} from '@forge/contracts/support-reply-audit';
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
import { users } from './schema-auth.js';
import { conversations } from './schema-conversations.js';
import { corrections } from './schema-lessons.js';
import { projects } from './schema-projects.js';
import { supportRooms } from './schema-support.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/** Who audited: a room's agent, or a master, a run or the steward auditing its own output. */
export const VERDICT_AGENTS = ['room', ...SELF_AUDIT_ROLES] as const;
/** What a non-room audit is about: an issue a master or run worked, or the steward's own run. */
export const VERDICT_OUTPUT_KINDS = [...SELF_AUDIT_OUTPUT_KINDS, 'steward_run'] as const;

/**
 * One verdict per reply its room's agent audited (`support/reply-audit/`): the rubric lines it failed,
 * who found each (the agent or code), and the room correction a failed one became in the lessons
 * store. `bot` is the Rocket.Chat connection whose account posted it; `roomKind` the room's kind then.
 * A reply with no row was never audited, which the read counts. A master's, run's or steward's audit
 * of its own output (ISS-1251, migration 0673) is a row with no room, naming the output instead, one
 * per output and role.
 */
export const supportReplyVerdicts = pgTable(
  'support_reply_verdicts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    agent: text('agent', { enum: VERDICT_AGENTS }).notNull().default('room'),
    roomId: uuid('room_id').references(() => supportRooms.id, { onDelete: 'cascade' }),
    roomKind: text('room_kind', { enum: SUPPORT_ROOM_KINDS }),
    bot: uuid('bot'),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    thread: text('thread'),
    /** The reply's chat message id: one verdict each, so a second audit changes nothing. */
    message: text('message'),
    /** A non-room audit's output: `issue` and its uuid, or `steward_run` and the run's id. */
    outputKind: text('output_kind', { enum: VERDICT_OUTPUT_KINDS }),
    outputRef: text('output_ref'),
    /** The account that audited, for a non-room audit. */
    byUserId: uuid('by_user_id').references(() => users.id, { onDelete: 'set null' }),
    verdict: text('verdict', { enum: REPLY_VERDICTS }).notNull(),
    failed: text('failed').array().notNull().default(sql`'{}'::text[]`),
    findings: jsonb('findings').notNull().default(sql`'[]'::jsonb`),
    /**
     * The capabilities the agent's own audit says the reply should have reached for and did not, each
     * `{ door, why }` (ISS-1251, migration 0672): the misses the capabilities page counts per card.
     */
    missed: jsonb('missed').notNull().default(sql`'[]'::jsonb`),
    correctionId: uuid('correction_id').references(() => corrections.id, { onDelete: 'set null' }),
    auditedAt: timestamp('audited_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    messageUq: uniqueIndex('support_reply_verdicts_message_uq').on(t.roomId, t.message),
    outputUq: uniqueIndex('support_reply_verdicts_output_uq')
      .on(t.projectId, t.agent, t.outputKind, t.outputRef)
      .where(sql`output_kind IS NOT NULL`),
    projectIdx: index('support_reply_verdicts_project_idx').on(t.projectId, t.auditedAt),
    botIdx: index('support_reply_verdicts_bot_idx').on(t.bot, t.auditedAt),
    roomKindChk: check(
      'support_reply_verdicts_room_kind_chk',
      sql`${t.roomKind} IN (${inList(SUPPORT_ROOM_KINDS)})`,
    ),
    agentChk: check(
      'support_reply_verdicts_agent_chk',
      sql`${t.agent} IN (${inList(VERDICT_AGENTS)}) AND (${t.agent} = 'room') = (${t.roomId} IS NOT NULL AND ${t.roomKind} IS NOT NULL AND ${t.bot} IS NOT NULL AND ${t.thread} IS NOT NULL AND ${t.message} IS NOT NULL) AND (${t.agent} <> 'room') = (${t.outputKind} IS NOT NULL AND ${t.outputRef} IS NOT NULL)`,
    ),
    outputKindChk: check(
      'support_reply_verdicts_output_kind_chk',
      sql`${t.outputKind} IS NULL OR ${t.outputKind} IN (${inList(VERDICT_OUTPUT_KINDS)})`,
    ),
    verdictChk: check(
      'support_reply_verdicts_verdict_chk',
      sql`${t.verdict} IN (${inList(REPLY_VERDICTS)}) AND (${t.verdict} = 'fail') = (cardinality(${t.failed}) > 0)`,
    ),
  }),
);
