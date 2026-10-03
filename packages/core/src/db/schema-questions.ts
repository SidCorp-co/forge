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

import type { QuestionnaireItem } from '@forge/contracts/onboarding';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
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
import type { ConversationAdapter } from './schema-conversations.js';
import { feedback } from './schema-feedback.js';
import { questionnaireBatches } from './schema-onboarding.js';
import { requirements } from './schema-requirements.js';

export const questionStatuses = ['open', 'answered', 'void', 'expired', 'needs_info'] as const;
export type QuestionStatus = (typeof questionStatuses)[number];

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

export const answerShapes = ['choice', 'free_text'] as const;
export type AnswerShape = (typeof answerShapes)[number];

type StepCommon = {
  round: number;
  prompt: string;
  askedAt: string;
  answeredAt?: string;
  answeredBy?: string;
  note?: string;
  sensitive?: boolean;
};

export type ChoiceStep = StepCommon & {
  answerShape: 'choice';
  options: QuestionOption[];
  recommendedOptionId: string;
  chosenOptionId?: string;
};

export type FreeTextStep = StepCommon & {
  answerShape: 'free_text';
  needed: string;
  answerText?: string;
};

export type QuestionStep = ChoiceStep | FreeTextStep;

export function chosenOptionIdOf(step: QuestionStep | undefined): string | null {
  if (!step || !isChoiceStep(step)) return null;
  return step.chosenOptionId ?? null;
}

export function isChoiceStep(step: QuestionStep): step is ChoiceStep {
  if (step.answerShape === 'choice') return true;
  const untagged = step as { answerShape?: AnswerShape; options?: unknown };
  return untagged.answerShape === undefined && Array.isArray(untagged.options);
}

/**
 * Where a question was asked, recorded when it was asked.
 */
export type QuestionOrigin =
  | {
      kind: 'conversation';
      adapter: ConversationAdapter;
      /** The venue's own id, in that adapter's vocabulary — `ports.ts`'s `externalId`. */
      venueId: string;
      conversationId: string;
      /** The window an agent-mode turn asked in; null for a questionnaire item, posted outside any window. */
      windowId: string | null;
      /** The transport's id for the message this question was raised against; null where it named none. */
      anchorId: string | null;
      askedByUserId: string | null;
      askedByLabel: string | null;
      /** The transport's own id for whoever spoke, which a directory can be asked about. */
      askedByKey: string | null;
    }
  | { kind: 'channel_gate'; documentId: string; number: string }
  | { kind: 'unresolved'; reason: string };

export const agentQuestions = pgTable(
  'agent_questions',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    /** The requirement a BA clarification is scoped to (Q5); null on every other question. */
    requirementId: uuid('requirement_id').references(() => requirements.id, {
      onDelete: 'cascade',
    }),
    /** The feedback item a BA clarification is scoped to (Q5); null on every other question. */
    feedbackId: uuid('feedback_id').references((): AnyPgColumn => feedback.id, {
      onDelete: 'cascade',
    }),
    agentSessionId: uuid('agent_session_id').references(() => agentSessions.id, {
      onDelete: 'set null',
    }),
    /** The questionnaire batch this item was asked in (ISS-63); null on every other question. */
    batchId: uuid('batch_id').references(() => questionnaireBatches.id, { onDelete: 'cascade' }),
    /** The item as posted: group, control, options, inferred default, evidence, the designs it shapes. */
    item: jsonb('item').$type<QuestionnaireItem>(),
    status: text('status', { enum: questionStatuses }).notNull().default('open'),
    blockerKind: text('blocker_kind', { enum: questionBlockerKinds }).notNull(),
    steps: jsonb('steps').$type<QuestionStep[]>().notNull(),
    maxRounds: integer('max_rounds').notNull().default(3),
    assumed: jsonb('assumed').$type<Record<string, unknown>>(),
    origin: jsonb('origin').$type<QuestionOrigin>(),
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
    index('agent_questions_issue_idx').on(t.issueId),
    index('agent_questions_batch_idx').on(t.batchId),
    check('agent_questions_batch_item_chk', sql`(${t.batchId} IS NULL) = (${t.item} IS NULL)`),
    // cm:guard the BA assistant asks the reporter at most one open question per item (Q5)
    uniqueIndex('agent_questions_requirement_open_uq')
      .on(t.requirementId)
      .where(sql`${t.status} = 'open' and ${t.requirementId} is not null`),
    uniqueIndex('agent_questions_feedback_open_uq')
      .on(t.feedbackId)
      .where(sql`${t.status} = 'open' and ${t.feedbackId} is not null`),
    // cm:why a channel document waits at its gate on one open question, so two approvers cannot each publish a copy
    uniqueIndex('agent_questions_channel_gate_open_uq')
      .on(sql`(${t.origin} ->> 'documentId')`)
      .where(sql`${t.status} = 'open' and ${t.origin} ->> 'kind' = 'channel_gate'`),
    check(
      'agent_questions_origin_shape_chk',
      sql`${t.origin} is null or (
        (${t.origin} ->> 'kind' = 'unresolved' and ${t.origin} ? 'reason')
        or (
          ${t.origin} ->> 'kind' = 'channel_gate'
          and ${t.origin} ? 'documentId'
          and ${t.origin} ? 'number'
          and ${t.issueId} is null
          and ${t.agentSessionId} is null
        )
        or (
          ${t.origin} ->> 'kind' = 'conversation'
          and ${t.origin} ? 'adapter'
          and ${t.origin} ? 'venueId'
          and ${t.origin} ? 'conversationId'
          and ${t.origin} ? 'windowId'
        )
      )`,
    ),
  ],
);

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
