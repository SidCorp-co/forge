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

// cm:guard the relation is still named `rocketchat_question_threads` and MUST NOT be renamed, though it now holds issue threads too: a rolled-back binary registers a question thread with an untargeted `INSERT ... ON CONFLICT DO NOTHING`, and Postgres does not accept `ON CONFLICT` against a view, so leaving a compatibility view behind a rename would break the very path the rename was meant to protect (ISS-981).
// cm:guard one row per SUBJECT and not per round, because one decision is one thread: rounds two and three of a question post into the thread round one opened, so a thread id keyed per round cannot be unique and a unique index over the rounds refuses the follow-up outright (found by `rocketchat-question-delivery-e2e.test.ts` before this table existed).
// cm:guard `(connection_id, rid, tmid)` is UNIQUE here so a thread can never resolve to two subjects — a reply would otherwise be answered against whichever row the planner happened to return first, and with two kinds of subject sharing the key that is the difference between an answer and a comment (ISS-978 criterion 30, ISS-981).
// cm:guard the issue index is PARTIAL over live rows, never a plain unique on the column: a project rebound to another connection has to register its replacement thread, and a global unique would refuse it while the retired row still points into the room nobody is bound to (ISS-981).
export const rocketchatThreads = pgTable(
  'rocketchat_question_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // cm:guard exactly one of these is set and the CHECK below is what makes the other state unrepresentable: a row naming neither is a thread nobody can route a reply to, and a row naming both makes "is this reply an answer or a comment?" undecidable from the message alone, which is the whole reason the two threads are separate (ISS-981).
    questionId: uuid('question_id').references(() => agentQuestions.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    rid: text('rid').notNull(),
    tmid: text('tmid').notNull(),
    // cm:guard retirement is not deletion — a reply left on the retired thread is still resolved, so it can be refused by name instead of falling through to the conversation handler and reaching a model (ISS-981 criterion 35).
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

// cm:guard this ONE row carries both directions, and which one it is decides what it guards: an `inbound` row is the idempotency key a redelivery of the same Rocket.Chat message resolves to, and it is also what stops that comment being posted back into the room it came from. Splitting them into two tables would let a comment be both mirrored in and mirrored out (ISS-981).
// cm:guard `(connection_id, external_message_id)` is what makes inbound exactly-once, and it is written in the SAME transaction as the comment: Rocket.Chat re-emits after server-side enrichment and a restart replays it, so a tracker that is not the database does not survive either, and two comments from one message is two resume intents at `answer-resume.ts` — the agent runs twice (ISS-981).
// cm:guard `external_message_id` is NULL while an outbound row is merely claimed, which is why the unique index above can hold both directions: Postgres lets NULLs repeat in a unique index, so every unposted claim coexists and only a delivered id has to be unique.
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
    // cm:guard `refused` is TERMINAL and exists so a screen refusal stops being retried: the body of a stored comment never changes, so eight identical attempts end in the comment quietly ceasing to be owed — a comment dropped with nobody told, which is the one failure this lane exists to prevent. The row keeps `last_error`, so what was refused and why is on the record rather than only in a log line (ISS-981).
    // cm:guard `claimed` is written BEFORE the post and is not a completion, so a claim whose process died is retried once its `next_attempt_at` passes rather than being read as a delivery. Outbound is at-least-once by that choice: the claim counts attempts, never Rocket.Chat's acceptance, so a post the server took whose mark never landed is re-posted. What that buys is that no comment is ever lost, which is the direction a conversation has to fail in; it ends when the outbound door can carry a client-supplied message id (ISS-981).
    status: text('status', { enum: commentMirrorStatuses }).notNull(),
    externalMessageId: text('external_message_id'),
    // cm:guard an INBOUND row's announcement is a second obligation, not a detail of the write: the comment and its idempotency row commit together, but `commentCreated` is emitted after that commit, and a process dying in between leaves a comment nobody was told about — the parked session the reply was meant to wake never hears it, and the redelivery sees the row and stays silent. Null means still owed, and the lease below is how it is retried (ISS-981 criterion 12).
    announcedAt: timestamp('announced_at', { withTimezone: true }),
    // cm:guard the claim is a LEASE and not the announcement itself, which is what makes the emit at-least-once rather than at-most-once: an announcer that dies between claiming and emitting is released when this passes, and the drain announces the comment again. The consumer is idempotent on the comment id — `session-send.ts` deduplicates on `(kind, intentId)` and the fallback transition only matches an issue still parked — so a second emit costs nothing and a lost one costs the parked session the reply was written to wake (ISS-981 criterion 12).
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

// cm:guard ONE row, ever, and the `only` column with its CHECK is what enforces that rather than a convention: the watermark is the lower bound of every obligation this mirror has, and a second row would give two answers to which comments a room was never owed.
// cm:guard the bound is a single ROLLOUT instant and deliberately not per connection or per binding: an obligation has to survive its destination changing, and a per-connection watermark discards a comment whose project is rebound to a connection initialised later than the comment was written (ISS-981 criterion 32). Nothing expires it at the other end — a comment after this instant stays owed however long delivery takes.
export const rocketchatCommentMirrorState = pgTable(
  'rocketchat_comment_mirror_state',
  {
    only: boolean('only').primaryKey().default(true),
    since: timestamp('since', { withTimezone: true }).notNull(),
  },
  (t) => [check('rcq_mirror_state_one_row_chk', sql`${t.only}`)],
);

// cm:guard this lease exists because the thing that must not happen twice is an HTTP POST to another host, and the exclusion therefore cannot be a transaction or an advisory lock: holding either across `sendFixedReply` parks a pooled connection on a remote server's latency, and ten of them starve a ten-wide pool while `idle_in_transaction_session_timeout` can kill the transaction after Rocket.Chat already accepted the root (ISS-981).
// cm:guard it is claimed and COMMITTED before the post and deleted after the registration, so the window it covers is exactly the post. `expires_at` is what makes a claimer that died releasable — without it one crashed opener leaves an issue's comments undeliverable for ever, which is worse than the duplicate root the lease prevents (ISS-981 criterion 33).
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
