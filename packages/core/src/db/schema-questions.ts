import { QUESTION_STATUSES } from '@forge/contracts/question-machine';
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
import type { QuestionSuggestion } from '@forge/contracts/question-suggestion';
import type {
  AnswerCredential,
  AnswerHold,
  AnswerResume,
  QuestionAbout,
} from '@forge/contracts/questions';

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agentSessions } from './schema-agent-sessions.js';
import { users } from './schema-auth.js';
import { feedback } from './schema-feedback.js';
import { issues } from './schema-issues.js';
import { questionnaireBatches } from './schema-onboarding.js';
import { projects } from './schema-projects.js';
import { requirements } from './schema-requirements.js';
import type { ConversationAdapter } from './schema-vocabulary.js';
import { projectWorkflowDesigns } from './schema-workflows.js';

export const questionStatuses = QUESTION_STATUSES;
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
  /** A steward merge's: what the draft and the item it merges into are both about (REQ-48 r3 BC-16). */
  shares?: string;
};

export const answerShapes = ['choice', 'free_text'] as const;
export type AnswerShape = (typeof answerShapes)[number];

type StepCommon = {
  round: number;
  prompt: string;
  askedAt: string;
  answeredAt?: string;
  answeredBy?: string;
  /** The token the answer arrived on, and the MCP client holding it (REQ-27 BC-2); absent for a session's or a room's. */
  answeredWith?: AnswerCredential;
  note?: string;
  sensitive?: boolean;
  /** What the answer said the issue still waits on (ISS-257). */
  hold?: AnswerHold;
  /** What the answer did to the issue it stopped, written by the answer resume (ISS-258). */
  resume?: AnswerResume;
};

export type ChoiceStep = StepCommon & {
  answerShape: 'choice';
  options: QuestionOption[];
  recommendedOptionId: string;
  /** Why the asker recommends it, one line beside the question rather than inside it (REQ-48 r3 BC-14, migration 0516). */
  why?: string;
  chosenOptionId?: string;
};

export type FreeTextStep = StepCommon & {
  answerShape: 'free_text';
  needed: string;
  /** The answer the asker recommends, which a person may send as it stands (REQ-41 BC-2); absent on rounds asked before it was taken. */
  recommended?: string;
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

export type QuestionnaireLanding =
  | { workflowId: string; revision: number; by: string; at: string }
  | { suggestionId: string; by: string; at: string };

export const agentQuestions = pgTable(
  'agent_questions',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    /** The requirement a BA clarification or a revision's open question is asked of; null on every other question. */
    requirementId: uuid('requirement_id').references(() => requirements.id, {
      onDelete: 'cascade',
    }),
    /** The feedback item a BA clarification is scoped to: at most one open per item; null on every other question. */
    feedbackId: uuid('feedback_id').references((): AnyPgColumn => feedback.id, {
      onDelete: 'cascade',
    }),
    agentSessionId: uuid('agent_session_id').references(() => agentSessions.id, {
      onDelete: 'set null',
    }),
    /**
     * The account that asked through a door of its own (`POST /api/questions`): a person, an agent
     * token, the steward. Null where the system asked (a sweep, a park) or the ask predates 0512.
     */
    askedBy: uuid('asked_by').references(() => users.id, { onDelete: 'set null' }),
    /** The questionnaire batch this item was asked in (ISS-63); null on every other question. */
    batchId: uuid('batch_id').references(() => questionnaireBatches.id, { onDelete: 'cascade' }),
    /** The item as posted: group, control, options, inferred default, evidence, the designs it shapes. */
    item: jsonb('item').$type<QuestionnaireItem>(),
    /** Where the answered item landed: the proposed revisions and suggestions an onboarding update cites it from. */
    landedIn: jsonb('landed_in').$type<QuestionnaireLanding[]>(),
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
    /** The workflow design revision a park waits on: its approver's decision answers this question (ISS-254). */
    awaitsWorkflowId: uuid('awaits_workflow_id'),
    awaitsRevision: integer('awaits_revision'),
    /** The issue whose merge mark a park waits on: the stamp writing it answers this question. */
    awaitsMergeIssueId: uuid('awaits_merge_issue_id').references((): AnyPgColumn => issues.id, {
      onDelete: 'set null',
    }),
    /** What the asker named the question as about (a requirement, a contract, or the feedback item a steward decision is about); it moves no visibility. */
    about: jsonb('about').$type<QuestionAbout>(),
    /** The assistant's suggested answer for the current round, or why it drafted none (REQ-41 BC-2, migration 0482). */
    suggestion: jsonb('suggestion').$type<QuestionSuggestion>(),
    /** When the people owing the current round were reminded (day 3, REQ-68 BC-8, migration 0534); counts for the round asked before it. */
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    /** When the agent proposed deferring or dropping the requirement the round holds up (day 14, REQ-68 BC-8). */
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('agent_questions_project_status_idx').on(t.projectId, t.status),
    foreignKey({
      name: 'agent_questions_awaits_design_fk',
      columns: [t.awaitsWorkflowId, t.awaitsRevision],
      foreignColumns: [projectWorkflowDesigns.workflowId, projectWorkflowDesigns.revision],
    }),
    check(
      'agent_questions_awaits_design_chk',
      sql`(${t.awaitsWorkflowId} IS NULL) = (${t.awaitsRevision} IS NULL)`,
    ),
    index('agent_questions_awaits_design_open_idx')
      .on(t.awaitsWorkflowId, t.awaitsRevision)
      .where(sql`${t.status} = 'open' and ${t.awaitsWorkflowId} is not null`),
    // a question waits on one fact: a design decision or a merge mark, never both
    check(
      'agent_questions_awaits_one_chk',
      sql`${t.awaitsWorkflowId} IS NULL OR ${t.awaitsMergeIssueId} IS NULL`,
    ),
    index('agent_questions_awaits_merge_open_idx')
      .on(t.awaitsMergeIssueId)
      .where(sql`${t.status} = 'open' and ${t.awaitsMergeIssueId} is not null`),
    index('agent_questions_session_idx').on(t.agentSessionId),
    index('agent_questions_issue_idx').on(t.issueId),
    index('agent_questions_batch_idx').on(t.batchId),
    check('agent_questions_batch_item_chk', sql`(${t.batchId} IS NULL) = (${t.item} IS NULL)`),
    index('agent_questions_requirement_idx')
      .on(t.requirementId)
      .where(sql`${t.requirementId} is not null`),
    index('agent_questions_about_requirement_idx')
      .on(sql`(${t.about} ->> 'requirementId')`)
      .where(sql`${t.about} ->> 'kind' = 'requirement'`),
    // a merge mark answers its park with the mark; a business question is a person's to answer
    check(
      'agent_questions_about_not_merge_wait_chk',
      sql`${t.about} is null or ${t.awaitsMergeIssueId} is null`,
    ),
    check(
      'agent_questions_about_shape_chk',
      sql`${t.about} is null or (
        (${t.about} ->> 'kind' = 'requirement' and jsonb_typeof(${t.about} -> 'requirementId') = 'string')
        or (${t.about} ->> 'kind' = 'contract' and jsonb_typeof(${t.about} -> 'contract') = 'string')
        or (${t.about} ->> 'kind' = 'feedback' and jsonb_typeof(${t.about} -> 'feedbackId') = 'string')
      )`,
    ),
    check(
      'agent_questions_suggestion_shape_chk',
      sql`${t.suggestion} IS NULL OR (jsonb_typeof(${t.suggestion}) = 'object' AND ${t.suggestion} ->> 'outcome' IN ('suggested', 'failed') AND jsonb_typeof(${t.suggestion} -> 'round') = 'number')`,
    ),
    // the BA assistant asks the reporter of a feedback item one clarification at a time
    uniqueIndex('agent_questions_feedback_open_uq')
      .on(t.feedbackId)
      .where(sql`${t.status} = 'open' and ${t.feedbackId} is not null`),
    // a channel document waits at its gate on one open question, so two approvers cannot each publish a copy
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
