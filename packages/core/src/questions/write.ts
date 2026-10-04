// Everything that changes a question, and every refusal that keeps its shape.
//
// A question is refused at WRITE time or not at all. The other end of this is a
// runner on a box that compiles against none of these types, so a shape held
// only by TypeScript is a shape held nowhere (ISS-964 criteria 14, 16, 21).

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { QUESTION_MACHINE } from '@forge/contracts/question-machine';
import type { QuestionRefusalCode } from '@forge/contracts/questions';
import { eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';
import {
  type AnswerShape,
  agentQuestions,
  isChoiceStep,
  type QuestionBlockerKind,
  type QuestionOption,
  type QuestionOrigin,
  type QuestionStep,
} from '../db/schema-questions.js';
import type { IssueDependencyExecutor } from '../issues/index.js';
import { refuser } from '../lib/refusal.js';
import { type KernelActor, transition } from '../lifecycle/index.js';
import { notFound } from '../middleware/route-errors.js';
import { holds, type PermissionFacts } from '../permissions/index.js';
import { resolveAskOrigin } from './origin.js';
import { screenRound } from './screen.js';

/** The pool, or a caller's open transaction — a park writes its question inside the transition's. */
type QuestionExecutor = IssueDependencyExecutor;

export type AskAnswer =
  | { shape: 'choice'; options: QuestionOption[]; recommendedOptionId: string }
  | { shape: 'free_text'; needed: string };

export type AskInput = {
  id: string;
  projectId: string;
  issueId?: string;
  /** A BA clarification's requirement: at most one open question per requirement (Q5). */
  requirementId?: string;
  /** A BA clarification's feedback item: at most one open question per item (Q5). */
  feedbackId?: string;
  agentSessionId?: string;
  prompt: string;
  blockerKind: QuestionBlockerKind;
  answer: AskAnswer;
  assumed?: Record<string, unknown>;
  cost?: { claimsHeld?: number; workspacesPinned?: number; dependents?: number };
  maxRounds?: number;
  parkDeadlineAt?: Date;
  /** This round's material is private to whoever asked, so it is put to them in a direct room. */
  sensitive?: boolean;
  origin?: Extract<QuestionOrigin, { kind: 'channel_gate' }>;
};

export const refuseQuestion = refuser<QuestionRefusalCode>('QUESTION_REFUSED');

/** An option's authority is the permission choosing it takes. */
export const optionPermission = (option: QuestionOption) =>
  option.authority === 'admin' ? 'project.admin' : 'project.write';

export function mayChoose(option: QuestionOption, facts: PermissionFacts | null): boolean {
  return facts !== null && holds(facts, optionPermission(option));
}

function checkOptions(options: QuestionOption[], recommendedOptionId: string) {
  if (options.length === 0) {
    throw refuseQuestion(
      'QUESTION_OPTIONS_REQUIRED',
      'a question with no options is not a question',
    );
  }
  if (new Set(options.map((o) => o.id)).size !== options.length) {
    throw refuseQuestion(
      'QUESTION_OPTION_IDS_DUPLICATE',
      'two options on this round carry the same id — an answer names an option by id, so a repeated one records a choice nobody can read back',
    );
  }
  for (const o of options) {
    if (o.bindsTo === 'this_call' && !o.fingerprint?.trim()) {
      throw refuseQuestion(
        'QUESTION_REFUSED',
        `option ${o.id} binds to one call and carries no fingerprint of it — a permission that names no call allows the next call instead of the blocked one`,
      );
    }
  }
  if (!recommendedOptionId || !options.some((o) => o.id === recommendedOptionId)) {
    throw refuseQuestion(
      'QUESTION_RECOMMENDED_UNKNOWN',
      'every question carries a recommended option, and it must be one of this question own options — a human facing a queue owes a click, not a decision',
    );
  }
}

function checkAnswer(answer: AskAnswer): void {
  if (answer.shape === 'choice') {
    checkOptions(answer.options, answer.recommendedOptionId);
    return;
  }
  if (!answer.needed.trim()) {
    throw refuseQuestion(
      'QUESTION_SHAPE_INVALID',
      'a free-text round states what would settle it — the credential, the missing paragraph, which reading was meant. Without that the person is asked to guess what counts as an answer',
    );
  }
}

function step(round: number, prompt: string, answer: AskAnswer, sensitive?: boolean): QuestionStep {
  const built = buildStep(round, prompt, answer, sensitive);
  screenRound(built, (message, code) => {
    throw refuseQuestion(code, message);
  });
  return built;
}

function buildStep(
  round: number,
  prompt: string,
  answer: AskAnswer,
  sensitive?: boolean,
): QuestionStep {
  const askedAt = new Date().toISOString();
  const common = { round, prompt, askedAt, ...(sensitive ? { sensitive: true } : {}) };
  return answer.shape === 'choice'
    ? {
        ...common,
        answerShape: 'choice',
        options: answer.options,
        recommendedOptionId: answer.recommendedOptionId,
      }
    : { ...common, answerShape: 'free_text', needed: answer.needed };
}

async function checkIssueBelongsToProject(
  executor: QuestionExecutor,
  issueId: string | undefined,
  projectId: string,
): Promise<void> {
  if (!issueId) return;
  const [issue] = await executor
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!issue) {
    throw refuseQuestion('QUESTION_ISSUE_ELSEWHERE', `no issue ${issueId}`);
  }
  if (issue.projectId !== projectId) {
    throw refuseQuestion(
      'QUESTION_ISSUE_ELSEWHERE',
      `issue ${issueId} belongs to project ${issue.projectId}, not to ${projectId} — ask it under the issue's own project`,
    );
  }
}

/**
 * Locked `for share`, so a close racing this ask either commits first and is seen,
 * or waits for it.
 */
async function refuseFinishedWork(executor: QuestionExecutor, issueId: string | undefined) {
  if (!issueId) return;
  const rows = await executor.execute(
    sql`select status from issues where id = ${issueId} for share`,
  );
  const status = (rows[0] as { status?: IssueStatus } | undefined)?.status;
  if (status && ISSUE_TERMINAL_STATUSES.includes(status)) {
    throw refuseQuestion(
      'QUESTION_ISSUE_TERMINAL',
      `issue ${issueId} is \`${status}\` — the work this would ask about is finished, so no answer could reach it. Reopen the issue first if the question still stands`,
    );
  }
}

/**
 * The one path every door's question is written through: shape, owning project,
 * live issue, row.
 */
export async function insertAskedQuestion(executor: QuestionExecutor, input: AskInput) {
  checkAnswer(input.answer);
  await checkIssueBelongsToProject(executor, input.issueId, input.projectId);
  await refuseFinishedWork(executor, input.issueId);
  return insertQuestion(executor, input);
}

export async function askQuestion(input: AskInput) {
  return db.transaction((tx) => insertAskedQuestion(tx, input));
}

export async function askParkQuestion(
  executor: QuestionExecutor,
  input: { id: string; projectId: string; issueId: string; prompt: string; needed: string },
) {
  const answer: AskAnswer = { shape: 'free_text', needed: input.needed };
  checkAnswer(answer);
  return insertQuestion(executor, {
    id: input.id,
    projectId: input.projectId,
    issueId: input.issueId,
    prompt: input.prompt,
    blockerKind: 'human',
    answer,
  });
}

async function insertQuestion(executor: QuestionExecutor, input: AskInput) {
  if (input.origin && (input.agentSessionId || input.issueId)) {
    throw new Error(
      'questions: a channel gate question belongs to no session and no issue, and this one names one',
    );
  }
  const origin = input.origin ?? (await resolveAskOrigin(executor, input.agentSessionId));
  const [row] = await executor
    .insert(agentQuestions)
    .values({
      id: input.id,
      projectId: input.projectId,
      issueId: input.issueId,
      requirementId: input.requirementId,
      feedbackId: input.feedbackId,
      agentSessionId: input.agentSessionId,
      blockerKind: input.blockerKind,
      steps: [step(1, input.prompt, input.answer, input.sensitive)],
      assumed: input.assumed,
      origin,
      maxRounds: input.maxRounds ?? 3,
      claimsHeld: input.cost?.claimsHeld ?? 0,
      workspacesPinned: input.cost?.workspacesPinned ?? 0,
      dependents: input.cost?.dependents ?? 0,
      parkDeadlineAt: input.parkDeadlineAt,
    })
    .returning();
  if (!row) throw new Error('the question was not written');
  return view(row);
}

export async function voidQuestion(args: {
  questionId: string;
  reason: string;
  actor: KernelActor;
}) {
  if (!args.reason?.trim()) {
    throw refuseQuestion(
      'QUESTION_REASON_REQUIRED',
      'a question is voided WITH a reason — removed silently it is indistinguishable from one nobody answered',
    );
  }
  const { rows: voided } = await transition(db, QUESTION_MACHINE, {
    to: 'void',
    from: 'open',
    set: { voidReason: args.reason, updatedAt: new Date() },
    where: eq(agentQuestions.id, args.questionId),
    reason: args.reason,
    actor: args.actor,
    source: 'questions',
    returning: ['id'],
  });
  if (voided.length > 0) return;
  const row = await load(args.questionId);
  throw refuseQuestion(
    'QUESTION_NOT_OPEN',
    `this question is ${row.status} — only an open question can be voided, and voiding an answered one would erase the answer`,
  );
}

async function load(id: string) {
  const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, id)).limit(1);
  if (!row) throw notFound(`no question ${id}`);
  return row;
}

export function answeredBody(step: QuestionStep | undefined): string {
  if (!step) return '';
  if (!isChoiceStep(step)) return step.answerText ?? '';
  return step.options.find((o) => o.id === step.chosenOptionId)?.label ?? '';
}

export function view<T extends { steps: QuestionStep[] }>(row: T) {
  const current = row.steps[row.steps.length - 1];
  return {
    ...row,
    answerShape: (current && !isChoiceStep(current) ? 'free_text' : 'choice') as AnswerShape,
    recommendedOptionId: current && isChoiceStep(current) ? current.recommendedOptionId : '',
  };
}

/** The clarification questions asked on a feedback, removed with what the reporter gave (UC15). */
export async function deleteFeedbackQuestions(tx: Tx, feedbackId: string): Promise<void> {
  await tx.delete(agentQuestions).where(eq(agentQuestions.feedbackId, feedbackId));
}

/** A questionnaire batch's items, each a question of its own, asked in the batch's transaction. */
export async function insertBatchQuestions(
  tx: Tx,
  rows: Array<typeof agentQuestions.$inferInsert>,
): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(agentQuestions).values(rows);
}
