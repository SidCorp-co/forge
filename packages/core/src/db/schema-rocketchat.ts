// What a Rocket.Chat room has been told, and which thread it was told in.
//
// Integration-owned on purpose. `agent_questions` carries no delivery column,
// because the instance that asked is not the instance that posts: the DDP
// client is single-owner per connection via a pg advisory lock, so a later
// round is delivered by whichever core instance holds that socket.
//
// There is no obligation column either. The obligation IS an open `human`
// question whose latest round has no row here, derived by a join rather than
// inserted, so a process that dies between the kernel commit and any emit
// leaves the work to be found rather than lost.

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { comments, integrationConnections, issues } from './schema.js';
import { agentQuestions } from './schema-questions.js';

export const questionDeliveryStatuses = ['claimed', 'delivered', 'undeliverable'] as const;
export type QuestionDeliveryStatus = (typeof questionDeliveryStatuses)[number];

export const rocketchatQuestionDeliveries = pgTable(
  'rocketchat_question_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => agentQuestions.id, { onDelete: 'cascade' }),
    round: integer('round').notNull(),
    status: text('status', { enum: questionDeliveryStatuses }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('rcq_deliveries_question_round_idx').on(t.questionId, t.round),
    index('rcq_deliveries_status_idx').on(t.status, t.nextAttemptAt),
  ],
);

export const rocketchatThreads = pgTable(
  'rocketchat_question_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questionId: uuid('question_id').references(() => agentQuestions.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    rid: text('rid').notNull(),
    tmid: text('tmid').notNull(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('rcq_threads_room_idx').on(t.connectionId, t.rid, t.tmid),
    uniqueIndex('rcq_threads_question_idx').on(t.questionId).where(sql`question_id IS NOT NULL`),
    uniqueIndex('rcq_threads_issue_live_idx')
      .on(t.issueId)
      .where(sql`issue_id IS NOT NULL AND retired_at IS NULL`),
    check('rcq_threads_subject_chk', sql`num_nonnulls(${t.questionId}, ${t.issueId}) = 1`),
  ],
);

export const commentMirrorDirections = ['outbound', 'inbound'] as const;
export type CommentMirrorDirection = (typeof commentMirrorDirections)[number];
export const commentMirrorStatuses = ['claimed', 'delivered', 'refused'] as const;
export type CommentMirrorStatus = (typeof commentMirrorStatuses)[number];

export const rocketchatCommentMirrors = pgTable(
  'rocketchat_comment_mirrors',
  {
    commentId: uuid('comment_id')
      .primaryKey()
      .references(() => comments.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    direction: text('direction', { enum: commentMirrorDirections }).notNull(),
    status: text('status', { enum: commentMirrorStatuses }).notNull(),
    externalMessageId: text('external_message_id'),
    announcedAt: timestamp('announced_at', { withTimezone: true }),
    announceLeaseUntil: timestamp('announce_lease_until', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('rcq_mirrors_external_idx').on(t.connectionId, t.externalMessageId),
    index('rcq_mirrors_status_idx').on(t.status, t.nextAttemptAt),
  ],
);

export const rocketchatCommentMirrorState = pgTable(
  'rocketchat_comment_mirror_state',
  {
    only: boolean('only').primaryKey().default(true),
    since: timestamp('since', { withTimezone: true }).notNull(),
  },
  (t) => [check('rcq_mirror_state_one_row_chk', sql`${t.only}`)],
);

export const rocketchatThreadOpenings = pgTable('rocketchat_thread_openings', {
  issueId: uuid('issue_id')
    .primaryKey()
    .references(() => issues.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id')
    .notNull()
    .references(() => integrationConnections.id, { onDelete: 'cascade' }),
  rid: text('rid').notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
