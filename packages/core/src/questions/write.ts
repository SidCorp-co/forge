// Everything that changes a question, and every refusal that keeps its shape.
//
// A question is refused at WRITE time or not at all. The other end of this is a
// runner on a box that compiles against none of these types, so a shape held
// only by TypeScript is a shape held nowhere (ISS-964 criteria 14, 16, 21).

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { QUESTION_MACHINE } from '@forge/contracts/question-machine';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues, type ProjectMemberRole } from '../db/schema.js';
import {
  type AnswerShape,
  agentQuestions,
  type ChoiceStep,
  isChoiceStep,
  type QuestionBlockerKind,
  type QuestionOption,
  type QuestionOrigin,
  type QuestionStep,
} from '../db/schema-questions.js';
import { decideChannelGate } from '../ecosystem/channel-gate.js';
import type { PersonVia } from '../ecosystem/channel-schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import type { IssueDependencyExecutor } from '../issues/dependency-executor.js';
import { type KernelActor, transition } from '../lifecycle/transition.js';
import { hooks } from '../pipeline/hooks.js';
import { wakeMastersForAnswer } from '../ws/master-wake.js';
import { batchItemRefusal } from './batch-item.js';
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
  'QUESTION_ISSUE_TERMINAL',
  'QUESTION_OPTIONS_REQUIRED',
  'QUESTION_RECOMMENDED_UNKNOWN',
  'QUESTION_OPTION_IDS_DUPLICATE',
  'QUESTION_SHAPE_INVALID',
  'QUESTION_ANSWER_WRONG_SHAPE',
  'QUESTION_MESSAGE_REFUSED',
  'QUESTION_CURSOR_INVALID',
  'QUESTION_NOTE_NOT_TAKEN',
  'QUESTION_IN_QUESTIONNAIRE',
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

function step(round: number, prompt: string, answer: AskAnswer, sensitive?: boolean): QuestionStep {
  const built = buildStep(round, prompt, answer, sensitive);
  screenRound(built, (message, code) => {
    throw new QuestionRefused(message, code);
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
    throw new QuestionRefused(`no issue ${issueId}`, 'QUESTION_ISSUE_ELSEWHERE');
  }
  if (issue.projectId !== projectId) {
    throw new QuestionRefused(
      `issue ${issueId} belongs to project ${issue.projectId}, not to ${projectId} — ask it under the issue's own project`,
      'QUESTION_ISSUE_ELSEWHERE',
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
    throw new QuestionRefused(
      `issue ${issueId} is \`${status}\` — the work this would ask about is finished, so no answer could reach it. Reopen the issue first if the question still stands`,
      'QUESTION_ISSUE_TERMINAL',
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
  agency: ActorAgency;
  role: ProjectMemberRole | null;
  note?: string;
  /** The door the answerer came through, which a channel gate records as the decider's via. */
  via: PersonVia;
};

export function mayAnswerFreeText(role: ProjectMemberRole | null): boolean {
  return role !== null;
}

/**
 * Record one answer, or refuse and leave the row exactly as it was.
 */
export async function answerQuestion(args: AnswerInput) {
  const { committed, effect } = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.id, args.questionId))
      .limit(1)
      .for('update');
    if (!row) throw new QuestionRefused(`no question ${args.questionId}`, 'QUESTION_NOT_FOUND');
    if (row.batchId) throw new QuestionRefused(...batchItemRefusal(row.id, row.batchId));
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
    const note = args.note?.trim() || undefined;
    if (args.note !== undefined && row.origin?.kind !== 'channel_gate') {
      throw new QuestionRefused(
        'a note travels only with an answer that carries it somewhere, and this question carries none — a channel gate takes one; here, answer with the option alone',
        'QUESTION_NOTE_NOT_TAKEN',
      );
    }
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
    let effect: (() => Promise<void>) | null = null;
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
        ...(note ? { note } : {}),
      };
      if (row.origin?.kind === 'channel_gate') {
        effect = await decideChannelGate(tx, {
          documentId: row.origin.documentId,
          projectId: row.projectId,
          optionId: option.id,
          note,
          by: args.by,
          via: args.via,
        });
      }
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
    await transition(tx, QUESTION_MACHINE, {
      to: 'answered',
      from: 'open',
      set: { steps, updatedAt: now },
      where: eq(agentQuestions.id, args.questionId),
      actor: { type: 'user', id: args.by, agency: args.agency },
      source: 'questions',
      returning: ['id'],
    });
    return { committed: { ...row, steps, status: 'answered' as const }, effect };
  });
  await hooks.emit('questionAnswered', {
    questionId: args.questionId,
    projectId: committed.projectId,
    issueId: committed.issueId ?? null,
    answeredBy: args.by,
    body: answeredBody(committed.steps.at(-1)),
  });
  void wakeMastersForAnswer({ projectId: committed.projectId, questionId: args.questionId });
  if (effect) await effect();
  return view(committed);
}

export async function voidQuestion(args: {
  questionId: string;
  reason: string;
  actor: KernelActor;
}) {
  if (!args.reason?.trim()) {
    throw new QuestionRefused(
      'a question is voided WITH a reason — removed silently it is indistinguishable from one nobody answered',
      'QUESTION_REASON_REQUIRED',
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
  const row = await load(args.questionId, 'QUESTION_NOT_FOUND');
  throw new QuestionRefused(
    `this question is ${row.status} — only an open question can be voided, and voiding an answered one would erase the answer`,
    'QUESTION_NOT_OPEN',
  );
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

async function load(id: string, code: QuestionRefusalCode = 'QUESTION_REFUSED') {
  const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, id)).limit(1);
  if (!row) throw new QuestionRefused(`no question ${id}`, code);
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
