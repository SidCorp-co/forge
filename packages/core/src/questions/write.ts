// Everything that changes a question, and every refusal that keeps its shape.
//
// A question is refused at WRITE time or not at all. The other end of this is a
// runner on a box that compiles against none of these types, so a shape held
// only by TypeScript is a shape held nowhere (ISS-964 criteria 14, 16, 21).

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, type ProjectMemberRole } from '../db/schema.js';
import {
  type AnswerShape,
  agentQuestions,
  type ChoiceStep,
  isChoiceStep,
  type QuestionBlockerKind,
  type QuestionOption,
  type QuestionStep,
} from '../db/schema-questions.js';
import type { IssueDependencyExecutor } from '../issues/dependency-executor.js';
import { hooks } from '../pipeline/hooks.js';
import { wakeMastersForAnswer } from '../ws/master-wake.js';
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
  agentSessionId?: string;
  prompt: string;
  blockerKind: QuestionBlockerKind;
  answer: AskAnswer;
  assumed?: Record<string, unknown>;
  cost?: { claimsHeld?: number; workspacesPinned?: number; dependents?: number };
  maxRounds?: number;
  parkDeadlineAt?: Date;
};

export class QuestionRefused extends Error {
  readonly code: QuestionRefusalCode;
  constructor(message: string, code: QuestionRefusalCode = 'QUESTION_REFUSED') {
    super(message);
    this.code = code;
  }
}

export const questionRefusalCodes = [
  'QUESTION_REFUSED',
  'QUESTION_NOT_FOUND',
  'QUESTION_NOT_OPEN',
  'QUESTION_EXPIRED',
  'QUESTION_ROUND_STALE',
  'QUESTION_OPTION_UNKNOWN',
  'QUESTION_AUTHORITY_REQUIRED',
  'QUESTION_REASON_REQUIRED',
  'QUESTION_ISSUE_ELSEWHERE',
  'QUESTION_OPTIONS_REQUIRED',
  'QUESTION_RECOMMENDED_UNKNOWN',
  'QUESTION_OPTION_IDS_DUPLICATE',
  'QUESTION_SHAPE_INVALID',
  'QUESTION_ANSWER_WRONG_SHAPE',
  'QUESTION_MESSAGE_REFUSED',
  'QUESTION_CURSOR_INVALID',
] as const;
export type QuestionRefusalCode = (typeof questionRefusalCodes)[number];

export function mayChoose(option: QuestionOption, role: ProjectMemberRole | null): boolean {
  if (role === 'admin') return true;
  if (role === 'member') return option.authority === 'writer';
  return false;
}

function checkOptions(options: QuestionOption[], recommendedOptionId: string) {
  if (options.length === 0) {
    throw new QuestionRefused(
      'a question with no options is not a question',
      'QUESTION_OPTIONS_REQUIRED',
    );
  }
  if (new Set(options.map((o) => o.id)).size !== options.length) {
    throw new QuestionRefused(
      'two options on this round carry the same id — an answer names an option by id, so a repeated one records a choice nobody can read back',
      'QUESTION_OPTION_IDS_DUPLICATE',
    );
  }
  for (const o of options) {
    if (o.bindsTo === 'this_call' && !o.fingerprint?.trim()) {
      throw new QuestionRefused(
        `option ${o.id} binds to one call and carries no fingerprint of it — a permission that names no call allows the next call instead of the blocked one`,
      );
    }
  }
  if (!recommendedOptionId || !options.some((o) => o.id === recommendedOptionId)) {
    throw new QuestionRefused(
      'every question carries a recommended option, and it must be one of this question own options — a human facing a queue owes a click, not a decision',
      'QUESTION_RECOMMENDED_UNKNOWN',
    );
  }
}

export function checkAnswer(answer: AskAnswer): void {
  if (answer.shape === 'choice') {
    checkOptions(answer.options, answer.recommendedOptionId);
    return;
  }
  if (!answer.needed.trim()) {
    throw new QuestionRefused(
      'a free-text round states what would settle it — the credential, the missing paragraph, which reading was meant. Without that the person is asked to guess what counts as an answer',
      'QUESTION_SHAPE_INVALID',
    );
  }
}

function step(round: number, prompt: string, answer: AskAnswer): QuestionStep {
  const built = buildStep(round, prompt, answer);
  screenRound(built, (message, code) => {
    throw new QuestionRefused(message, code);
  });
  return built;
}

function buildStep(round: number, prompt: string, answer: AskAnswer): QuestionStep {
  const askedAt = new Date().toISOString();
  return answer.shape === 'choice'
    ? {
        round,
        prompt,
        askedAt,
        answerShape: 'choice',
        options: answer.options,
        recommendedOptionId: answer.recommendedOptionId,
      }
    : { round, prompt, askedAt, answerShape: 'free_text', needed: answer.needed };
}

async function checkIssueBelongsToProject(
  issueId: string | undefined,
  projectId: string,
): Promise<void> {
  if (!issueId) return;
  const [issue] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!issue) {
    throw new QuestionRefused(`no issue ${issueId}`, 'QUESTION_ISSUE_ELSEWHERE');
  }
  if (issue.projectId !== projectId) {
    throw new QuestionRefused(
      `issue ${issueId} belongs to project ${issue.projectId}, not to ${projectId} — ask it under the issue's own project`,
      'QUESTION_ISSUE_ELSEWHERE',
    );
  }
}

export async function askQuestion(input: AskInput) {
  checkAnswer(input.answer);
  await checkIssueBelongsToProject(input.issueId, input.projectId);
  return insertQuestion(db, input);
}

/**
 * The question a park mints, written inside the transition's own transaction.
 */
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
  const [row] = await executor
    .insert(agentQuestions)
    .values({
      id: input.id,
      projectId: input.projectId,
      issueId: input.issueId,
      agentSessionId: input.agentSessionId,
      blockerKind: input.blockerKind,
      steps: [step(1, input.prompt, input.answer)],
      assumed: input.assumed,
      maxRounds: input.maxRounds ?? 3,
      claimsHeld: input.cost?.claimsHeld ?? 0,
      workspacesPinned: input.cost?.workspacesPinned ?? 0,
      dependents: input.cost?.dependents ?? 0,
      parkDeadlineAt: input.parkDeadlineAt,
    })
    .returning();
  if (!row) throw new QuestionRefused('the question was not written');
  return view(row);
}

export async function getQuestion(id: string) {
  const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, id)).limit(1);
  return row ? view(row) : null;
}

export async function openQuestionCount(projectId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentQuestions)
    .where(and(eq(agentQuestions.projectId, projectId), eq(agentQuestions.status, 'open')));
  return row?.n ?? 0;
}

export type GivenAnswer = { kind: 'option'; optionId: string } | { kind: 'text'; text: string };

export type AnswerInput = {
  questionId: string;
  answer: GivenAnswer;
  /** The round the answerer was looking at. Never defaulted to the current one. */
  round: number;
  by: string;
  role: ProjectMemberRole | null;
};

export function mayAnswerFreeText(role: ProjectMemberRole | null): boolean {
  return role !== null;
}

/**
 * Record one answer, or refuse and leave the row exactly as it was.
 */
export async function answerQuestion(args: AnswerInput) {
  const committed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.id, args.questionId))
      .limit(1)
      .for('update');
    if (!row) throw new QuestionRefused(`no question ${args.questionId}`, 'QUESTION_NOT_FOUND');
    const now = new Date();
    if (row.status !== 'open') {
      throw new QuestionRefused(
        `this question is ${row.status} — only an open question takes an answer`,
        'QUESTION_NOT_OPEN',
      );
    }
    if (row.parkDeadlineAt && row.parkDeadlineAt.getTime() <= now.getTime()) {
      throw new QuestionRefused(
        `this question's park deadline passed at ${row.parkDeadlineAt.toISOString()}`,
        'QUESTION_EXPIRED',
      );
    }
    const current = row.steps[row.steps.length - 1];
    if (!current) throw new QuestionRefused('this question has no round to answer');
    if (current.round !== args.round) {
      throw new QuestionRefused(
        `this answer names round ${args.round} and the question is on round ${current.round} — the round you were shown has been superseded`,
        'QUESTION_ROUND_STALE',
      );
    }
    const choice = isChoiceStep(current);
    if (choice !== (args.answer.kind === 'option')) {
      throw new QuestionRefused(
        choice
          ? `round ${current.round} offers options and this answer carries text — reply with the number of the option you mean`
          : `round ${current.round} asks for text and this answer names an option — it has none to name`,
        'QUESTION_ANSWER_WRONG_SHAPE',
      );
    }
    let answered: QuestionStep;
    if (isChoiceStep(current) && args.answer.kind === 'option') {
      const optionId = args.answer.optionId;
      const option = current.options.find((o) => o.id === optionId);
      if (!option) {
        throw new QuestionRefused(
          `option ${optionId} is not on round ${current.round} of this question`,
          'QUESTION_OPTION_UNKNOWN',
        );
      }
      if (!mayChoose(option, args.role)) {
        throw new QuestionRefused(
          `option ${option.id} carries authority ${option.authority} and this caller may not choose it`,
          'QUESTION_AUTHORITY_REQUIRED',
        );
      }
      answered = {
        ...current,
        answeredAt: now.toISOString(),
        chosenOptionId: option.id,
        answeredBy: args.by,
      };
    } else if (!isChoiceStep(current) && args.answer.kind === 'text') {
      const text = args.answer.text.trim();
      if (!text) {
        throw new QuestionRefused(
          `round ${current.round} asks for text and this answer carries none`,
          'QUESTION_ANSWER_WRONG_SHAPE',
        );
      }
      if (!mayAnswerFreeText(args.role)) {
        throw new QuestionRefused(
          'answering a free-text round writes into a running agent and needs a role that may write on this project',
          'QUESTION_AUTHORITY_REQUIRED',
        );
      }
      answered = {
        ...current,
        answeredAt: now.toISOString(),
        answerText: text,
        answeredBy: args.by,
      };
    } else {
      throw new QuestionRefused(
        `round ${current.round} and this answer do not name the same shape`,
        'QUESTION_ANSWER_WRONG_SHAPE',
      );
    }
    const steps = row.steps.map((s, i) => (i === row.steps.length - 1 ? answered : s));
    await tx
      .update(agentQuestions)
      .set({ steps, status: 'answered', updatedAt: now })
      .where(eq(agentQuestions.id, args.questionId));
    return { ...row, steps, status: 'answered' as const };
  });
  await hooks.emit('questionAnswered', {
    questionId: args.questionId,
    projectId: committed.projectId,
    issueId: committed.issueId ?? null,
    answeredBy: args.by,
    body: answeredBody(committed.steps.at(-1)),
  });
  void wakeMastersForAnswer({ projectId: committed.projectId, questionId: args.questionId });
  return view(committed);
}

export async function askFollowUp(args: { questionId: string; prompt: string; answer: AskAnswer }) {
  const row = await load(args.questionId);
  checkAnswer(args.answer);
  if (row.steps.length >= row.maxRounds) {
    await db
      .update(agentQuestions)
      .set({ status: 'needs_info', updatedAt: new Date() })
      .where(eq(agentQuestions.id, args.questionId));
    throw new QuestionRefused(
      `max_rounds ${row.maxRounds} reached — the thread is the record now, and this question is needs_info`,
    );
  }
  const steps = [...row.steps, step(row.steps.length + 1, args.prompt, args.answer)];
  await db
    .update(agentQuestions)
    .set({ steps, status: 'open', updatedAt: new Date() })
    .where(eq(agentQuestions.id, args.questionId));
  return view({ ...row, steps, status: 'open' as const });
}

export async function voidQuestion(args: { questionId: string; reason: string }) {
  if (!args.reason?.trim()) {
    throw new QuestionRefused(
      'a question is voided WITH a reason — removed silently it is indistinguishable from one nobody answered',
      'QUESTION_REASON_REQUIRED',
    );
  }
  await db
    .update(agentQuestions)
    .set({ status: 'void', voidReason: args.reason, updatedAt: new Date() })
    .where(eq(agentQuestions.id, args.questionId));
}

/**
 * Does the answer on this question cover the call about to be made?
 */
export async function checkPermission(args: { questionId: string; fingerprint: string }) {
  const row = await load(args.questionId);
  const answered = row.steps.filter((s) => isChoiceStep(s) && s.chosenOptionId).at(-1) as
    | ChoiceStep
    | undefined;
  const chosen = answered?.options.find((o) => o.id === answered.chosenOptionId);
  if (!chosen) throw new QuestionRefused('this question carries no answer to check');
  if (chosen.bindsTo !== 'this_call') return true;
  if (chosen.fingerprint !== args.fingerprint) {
    throw new QuestionRefused(
      `fingerprint mismatch: this permission was given for \`${chosen.fingerprint}\` and is being presented for \`${args.fingerprint}\``,
    );
  }
  return true;
}

async function load(id: string) {
  const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, id)).limit(1);
  if (!row) throw new QuestionRefused(`no question ${id}`);
  return row;
}

function answeredBody(step: QuestionStep | undefined): string {
  if (!step) return '';
  if (!isChoiceStep(step)) return step.answerText ?? '';
  return step.options.find((o) => o.id === step.chosenOptionId)?.label ?? '';
}

function view<T extends { steps: QuestionStep[] }>(row: T) {
  const current = row.steps[row.steps.length - 1];
  return {
    ...row,
    answerShape: (current && !isChoiceStep(current) ? 'free_text' : 'choice') as AnswerShape,
    recommendedOptionId: current && isChoiceStep(current) ? current.recommendedOptionId : '',
  };
}
