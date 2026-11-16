// ISS-1250 (owner, 2026-11-16), owned by the `support` domain beside its rooms (`schema-support.ts`),
// kept apart only for size: a room agent's audit of its own reply.

import { SUPPORT_ROOM_KINDS } from '@forge/contracts/support-operations';
import { REPLY_VERDICTS } from '@forge/contracts/support-reply-audit';
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
import { conversations } from './schema-conversations.js';
import { corrections } from './schema-lessons.js';
import { projects } from './schema-projects.js';
import { supportRooms } from './schema-support.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * One verdict per reply its room's agent audited (`support/reply-audit/`): the rubric lines it failed,
 * who found each (the agent or code), and the room correction a failed one became in the lessons
 * store. `bot` is the Rocket.Chat connection whose account posted it; `roomKind` the room's kind then.
 * A reply with no row was never audited, which the read counts.
 */
export const supportReplyVerdicts = pgTable(
  'support_reply_verdicts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    roomId: uuid('room_id')
      .notNull()
      .references(() => supportRooms.id, { onDelete: 'cascade' }),
    roomKind: text('room_kind', { enum: SUPPORT_ROOM_KINDS }).notNull(),
    bot: uuid('bot').notNull(),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    thread: text('thread').notNull(),
    /** The reply's chat message id: one verdict each, so a second audit changes nothing. */
    message: text('message').notNull(),
    verdict: text('verdict', { enum: REPLY_VERDICTS }).notNull(),
    failed: text('failed').array().notNull().default(sql`'{}'::text[]`),
    findings: jsonb('findings').notNull().default(sql`'[]'::jsonb`),
    correctionId: uuid('correction_id').references(() => corrections.id, { onDelete: 'set null' }),
    auditedAt: timestamp('audited_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    messageUq: uniqueIndex('support_reply_verdicts_message_uq').on(t.roomId, t.message),
    projectIdx: index('support_reply_verdicts_project_idx').on(t.projectId, t.auditedAt),
    botIdx: index('support_reply_verdicts_bot_idx').on(t.bot, t.auditedAt),
    roomKindChk: check(
      'support_reply_verdicts_room_kind_chk',
      sql`${t.roomKind} IN (${inList(SUPPORT_ROOM_KINDS)})`,
    ),
    verdictChk: check(
      'support_reply_verdicts_verdict_chk',
      sql`${t.verdict} IN (${inList(REPLY_VERDICTS)}) AND (${t.verdict} = 'fail') = (cardinality(${t.failed}) > 0)`,
    ),
  }),
);
