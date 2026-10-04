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

import {
  QUESTION_DELIVERY_STATUSES,
  type QuestionDeliveryStatus,
} from '@forge/contracts/room-delivery-machine';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { integrationConnections } from './schema.js';
import { agentQuestions } from './schema-questions.js';

export const questionDeliveryStatuses = QUESTION_DELIVERY_STATUSES;
export type { QuestionDeliveryStatus };

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
    check(
      'rcq_deliveries_status_chk',
      sql`${t.status} IN (${sql.raw(QUESTION_DELIVERY_STATUSES.map((s) => `'${s}'`).join(', '))})`,
    ),
  ],
);

export const rocketchatThreads = pgTable(
  'rocketchat_question_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => agentQuestions.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    rid: text('rid').notNull(),
    tmid: text('tmid').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('rcq_threads_room_idx').on(t.connectionId, t.rid, t.tmid),
    uniqueIndex('rcq_threads_question_idx').on(t.questionId).where(sql`question_id IS NOT NULL`),
  ],
);
