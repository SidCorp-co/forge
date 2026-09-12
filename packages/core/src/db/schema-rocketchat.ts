// What a Rocket.Chat room has been told about a parked question, and which thread it was told in.
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

import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { integrationConnections } from './schema.js';
import { agentQuestions } from './schema-questions.js';

export const questionDeliveryStatuses = ['claimed', 'delivered', 'undeliverable'] as const;
export type QuestionDeliveryStatus = (typeof questionDeliveryStatuses)[number];

// cm:guard `delivered` is written only after the post returned a message id and the thread row below carries it: a round marked delivered whose question has no thread is one nobody can reply to, because the inbound side finds a reply by (connection_id, rid, tmid) and by nothing else (ISS-978 criteria 7, 8).
// cm:guard `claimed` is one instance saying it is posting this round right now, and it is written BEFORE the post so two core instances cannot both post it: the drain runs on every instance, and the DDP connection's advisory lock guards the socket rather than this. It is not a completion — `delivered` is — so a claim whose post died is retried once its `next_attempt_at` passes.
// cm:guard the ABSENCE of a row is still the obligation, which is why there is no `pending`: an unclaimed round is derived from `agent_questions` alone, so nothing had to be written for it to be found.
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
    // cm:guard one row per ROUND, which is what makes a round the unit of delivery: round two of a question is a second obligation against the same thread, and keying on the question alone would let a follow-up look already delivered.
    uniqueIndex('rcq_deliveries_question_round_idx').on(t.questionId, t.round),
    index('rcq_deliveries_status_idx').on(t.status, t.nextAttemptAt),
  ],
);

// cm:guard one row per QUESTION and not per round, because one decision is one thread: rounds two and three of a question post into the thread round one opened, so a thread id keyed per round cannot be unique and a unique index over the rounds refuses the follow-up outright (found by `rocketchat-question-delivery-e2e.test.ts` before this table existed).
// cm:guard `(connection_id, rid, tmid)` is UNIQUE here so a thread can never resolve to two questions — a reply would otherwise be answered against whichever row the planner happened to return first (ISS-978 criterion 30).
export const rocketchatQuestionThreads = pgTable(
  'rocketchat_question_threads',
  {
    questionId: uuid('question_id')
      .primaryKey()
      .references(() => agentQuestions.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    rid: text('rid').notNull(),
    tmid: text('tmid').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('rcq_threads_room_idx').on(t.connectionId, t.rid, t.tmid)],
);
