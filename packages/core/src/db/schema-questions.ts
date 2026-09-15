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

// cm:guard a step declares its answer shape and a reader NEVER infers one from which fields happen to be present: a step carrying both an option list and a needed-text line is two questions in one row, and whichever field the reader looks at first decides what the person is asked. The write path refuses that row by name (`questions/write.ts`).
// cm:edge lockstep -> packages/runner/crates/forge-runner-core/src/transport/questions.rs — the box reads the answer back off the wire and branches on this same tag; a shape added here that the runner does not know reaches it as an answer it cannot act on, and the park never ends.
export const answerShapes = ['choice', 'free_text'] as const;
export type AnswerShape = (typeof answerShapes)[number];

type StepCommon = {
  round: number;
  prompt: string;
  askedAt: string;
  answeredAt?: string;
  answeredBy?: string;
};

export type ChoiceStep = StepCommon & {
  answerShape: 'choice';
  options: QuestionOption[];
  recommendedOptionId: string;
  chosenOptionId?: string;
};

// cm:guard `needed` is REQUIRED and is not the prompt said twice: the prompt is the question, this is what would settle it — the credential, the missing paragraph, which of the two readings was meant. A free-text round without it asks a person to guess what counts as an answer, which is the failure the option list never had (ISS-996).
export type FreeTextStep = StepCommon & {
  answerShape: 'free_text';
  needed: string;
  answerText?: string;
};

export type QuestionStep = ChoiceStep | FreeTextStep;

// cm:guard absence of the tag means `choice` and has exactly one legal source: a row written before ISS-996, when a choice was the only shape there was. It is NOT a default for a caller that forgot the field — `questions/write.ts` refuses that at the door — and the migration that stamps the tag onto stored rows is what drains this arm. Same shape as a body whose `format` is absent resolving to `markdown`, and for the same reason: an old row must keep the one meaning it ever had.
// cm:guard the ONE reader of a chosen option, and it answers `null` for a free-text round rather than `undefined`: a caller that reaches for the field directly gets a type error on the union, which is what stops a text round being read as an unanswered choice one (ISS-996).
export function chosenOptionIdOf(step: QuestionStep | undefined): string | null {
  if (!step || !isChoiceStep(step)) return null;
  return step.chosenOptionId ?? null;
}

export function isChoiceStep(step: QuestionStep): step is ChoiceStep {
  if (step.answerShape === 'choice') return true;
  const untagged = step as { answerShape?: AnswerShape; options?: unknown };
  return untagged.answerShape === undefined && Array.isArray(untagged.options);
}

export const agentQuestions = pgTable(
  'agent_questions',
  {
    // cm:guard on the BOX's door (`POST /api/devices/me/questions`) the id is minted by the runner and sent, never allocated here: the box writes its own half of the park in a local transaction before core has seen anything, and a server-allocated id would make the two halves unjoinable across the window where the box has parked and core has not heard (ISS-964 criterion 10). `POST /api/questions` allocates, because a caller holding a token has written no local half to join to (ISS-993).
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
    // cm:guard ISS-1022 — `readQuestionsForIssue` is the door every issue screen opens and it filters on `issue_id` first; neither index above leads with it, so the lookup was a sequential scan of the whole table.
    index('agent_questions_issue_idx').on(t.issueId),
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
