// The question a blocked run asks, and the thread it becomes.
//
// One row per DECISION, never one per round: a chain of follow-ups is `steps`
// on this row, so a queue ordered by the cost of blocking counts a decision
// once however many times the agent had to come back (ISS-964 criterion 20).
//
// There is no shape discriminator. What an option does is three
// orthogonal facts on the option itself — who may choose it, how far the choice
// reaches, and who carries it out — and any pair of them is legal.
//
// Split out of `schema.ts` for size, like `schema-session-inbox.ts`, and
// registered in `drizzle.config.ts` and the client's schema map beside it.

import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agentSessions, issues, projects } from './schema.js';

export const questionStatuses = ['open', 'answered', 'void', 'expired', 'needs_info'] as const;
export type QuestionStatus = (typeof questionStatuses)[number];

// cm:guard `nobody` is absent on purpose and must stay absent: a blocker with no possible resolver is a failure with a name and writes NO question, so a row carrying it could only ever be one nobody can answer (ISS-964 criterion 3).
export const questionBlockerKinds = ['machine', 'master_or_peer', 'human'] as const;
export type QuestionBlockerKind = (typeof questionBlockerKinds)[number];

export const optionAuthorities = ['writer', 'admin'] as const;
export const optionBindings = ['this_call', 'session', 'project'] as const;
export const optionExecutors = ['agent', 'core', 'human'] as const;

export type QuestionOption = {
  id: string;
  label: string;
  authority: (typeof optionAuthorities)[number];
  bindsTo: (typeof optionBindings)[number];
  executedBy: (typeof optionExecutors)[number];
  fingerprint?: string;
};

export type QuestionStep = {
  round: number;
  prompt: string;
  options: QuestionOption[];
  recommendedOptionId: string;
  askedAt: string;
  answeredAt?: string;
  chosenOptionId?: string;
  answeredBy?: string;
};

export const agentQuestions = pgTable(
  'agent_questions',
  {
    // cm:guard the id is MINTED BY THE RUNNER and sent, never allocated here. The box writes its own half of the park in a local transaction before core has seen anything, and a server-allocated id would make the two halves unjoinable across the window where the box has parked and core has not heard (ISS-964 criterion 10).
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    agentSessionId: uuid('agent_session_id').references(() => agentSessions.id, {
      onDelete: 'set null',
    }),
    status: text('status', { enum: questionStatuses }).notNull().default('open'),
    blockerKind: text('blocker_kind', { enum: questionBlockerKinds }).notNull(),
    steps: jsonb('steps').$type<QuestionStep[]>().notNull(),
    maxRounds: integer('max_rounds').notNull().default(3),
    // cm:guard the premise is stored so drift can be DETECTED rather than assumed away. A question answered against a premise that has since moved is worse than an unanswered one: it is a decision taken about a world that no longer exists (ISS-964 criterion 22).
    assumed: jsonb('assumed').$type<Record<string, unknown>>(),
    voidReason: text('void_reason'),
    claimsHeld: integer('claims_held').notNull().default(0),
    workspacesPinned: integer('workspaces_pinned').notNull().default(0),
    dependents: integer('dependents').notNull().default(0),
    parkDeadlineAt: timestamp('park_deadline_at', { withTimezone: true }),
    endedBy: text('ended_by'),
    endedReason: text('ended_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('agent_questions_project_status_idx').on(t.projectId, t.status),
    index('agent_questions_session_idx').on(t.agentSessionId),
  ],
);

// cm:guard the waiter is a ROW per run, never a count on the question. One answer revives all N of them and each needs its own revival to succeed or fail, so a counter would leave a run that failed to revive indistinguishable from one that never waited (ISS-964 criterion 18).
export const questionWaiters = pgTable(
  'question_waiters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => agentQuestions.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').notNull(),
    runId: text('run_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('question_waiters_question_idx').on(t.questionId),
    uniqueIndex('question_waiters_run_idx').on(t.questionId, t.deviceId, t.runId),
  ],
);
