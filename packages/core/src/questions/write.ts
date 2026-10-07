// Everything that changes a question, and every refusal that keeps its shape.
//
// A question is refused at WRITE time or not at all. The other end of this is a
// runner on a box that compiles against none of these types, so a shape held
// only by TypeScript is a shape held nowhere (ISS-964 criteria 14, 16, 21).

import { randomUUID } from 'node:crypto';
import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import type { QuestionRefusalCode } from '@forge/contracts/questions';
import { scrubSecretsDeep } from '@forge/observability';
import { eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';
import {
  type AnswerShape,
  agentQuestions,
  isChoiceStep,
  type QuestionBlockerKind,
  type QuestionnaireLanding,
  type QuestionOption,
  type QuestionOrigin,
  type QuestionStep,
} from '../db/schema-questions.js';
import type { IssueDependencyExecutor } from '../issues/index.js';
import { refuser } from '../lib/refusal.js';
import type { KernelActor } from '../lifecycle/index.js';
import { emitEvent, emitEvents } from '../outbox/index.js';
import { holds, type PermissionFacts } from '../permissions/index.js';
import {
  type AwaitedDesign,
  awaitedDesignFault,
  designsPendingUnder,
  linkedDesignLine,
  neededFor,
  type PendingDesign,
  voidSupersededDesignQuestions,
} from './design-wait.js';
import { type AwaitedMerge, awaitedMergeFault, neededForMerge } from './merge-wait.js';
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
  /** The design revision whose decision answers this question; only a park names one. */
  awaitsDesign?: AwaitedDesign;
  /** The issue whose merge mark answers this question; only a park names one. */
  awaitsMerge?: AwaitedMerge;
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
  input: {
    id: string;
    projectId: string;
    issueId: string;
    prompt: string;
    needed?: string | undefined;
    awaitsDesign?: AwaitedDesign | undefined;
    /** Core linked `awaitsDesign` itself, as the one revision proposed under this issue: the question says so. */
    linkedUnderIssue?: boolean | undefined;
    awaitsMerge?: AwaitedMerge | undefined;
  },
) {
  if (input.awaitsDesign && input.awaitsMerge) {
    throw new Error(
      'questions: a park question waits on one fact, a design decision or a merge mark, and this one names both',
    );
  }
  let needed = input.needed?.trim() ?? '';
  let prompt = input.prompt;
  if (input.awaitsDesign) {
    const awaited = await awaitedDesignFault(executor, input.projectId, input.awaitsDesign);
    if ('fault' in awaited) throw refuseQuestion(awaited.fault.code, awaited.fault.detail);
    needed ||= neededFor(awaited.flow, input.awaitsDesign.revision);
    if (input.linkedUnderIssue) {
      const line = linkedDesignLine(awaited.flow, input.awaitsDesign.revision);
      prompt = prompt.trim()
        ? `${prompt.trim()} (${line})`
        : `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
    }
  }
  if (input.awaitsMerge) {
    const awaited = await awaitedMergeFault(executor, input.projectId, input.awaitsMerge);
    if ('fault' in awaited) throw refuseQuestion(awaited.fault.code, awaited.fault.detail);
    needed ||= neededForMerge(awaited.key);
  }
  const answer: AskAnswer = { shape: 'free_text', needed };
  checkAnswer(answer);
  return insertQuestion(executor, {
    id: input.id,
    projectId: input.projectId,
    issueId: input.issueId,
    prompt,
    blockerKind: 'human',
    answer,
    ...(input.awaitsDesign ? { awaitsDesign: input.awaitsDesign } : {}),
    ...(input.awaitsMerge ? { awaitsMerge: input.awaitsMerge } : {}),
  });
}

/**
 * The revision an agent's park waits on when it names none: the one revision proposed under the
 * parking issue that still awaits its approver, which is a kernel fact rather than a reading of the
 * park's words. None pending is null; two or more are refused by name, since which one settles the
 * park is the agent's to say.
 */
export async function pendingDesignOfPark(
  executor: QuestionExecutor,
  projectId: string,
  issueId: string,
): Promise<PendingDesign | null> {
  const pending = await designsPendingUnder(executor, projectId, issueId);
  if (pending.length <= 1) return pending[0] ?? null;
  const named = pending
    .map((p) => `\`${p.flow}\` revision ${p.revision} (workflowId ${p.workflowId})`)
    .join(', ');
  throw refuseQuestion(
    'QUESTION_DESIGN_AMBIGUOUS',
    `this park names no \`awaitsDesign\`, and ${pending.length} design revisions proposed under this issue await their approver: ${named}. Core links the one revision proposed under the issue and cannot pick among several — send \`awaitsDesign: { workflowId, revision }\` naming the one whose decision settles this park; nothing was written`,
  );
}

/**
 * A write superseded a revision nobody had decided: void the questions waiting on it and ask each
 * issue again, of the revision that replaced it, inside the write's transaction (ISS-254).
 */
export async function reaskSupersededDesignQuestions(
  tx: Tx,
  args: {
    workflowId: string;
    superseded: number;
    revision: number;
    flow: string;
    by: string;
    actor: KernelActor;
  },
): Promise<void> {
  const voided = await voidSupersededDesignQuestions(tx, args);
  const asked = new Set<string>();
  for (const { projectId, issueId } of voided) {
    if (!issueId || asked.has(issueId)) continue;
    asked.add(issueId);
    await askParkQuestion(tx, {
      id: randomUUID(),
      projectId,
      issueId,
      prompt: `Design \`${args.flow}\` revision ${args.superseded}, which this issue was parked on, was superseded by revision ${args.revision} before anyone decided it. Approve or return revision ${args.revision} on its design page.`,
      awaitsDesign: { workflowId: args.workflowId, revision: args.revision },
    });
  }
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
      assumed: scrubSecretsDeep(input.assumed),
      origin,
      maxRounds: input.maxRounds ?? 3,
      claimsHeld: input.cost?.claimsHeld ?? 0,
      workspacesPinned: input.cost?.workspacesPinned ?? 0,
      dependents: input.cost?.dependents ?? 0,
      parkDeadlineAt: input.parkDeadlineAt,
      awaitsWorkflowId: input.awaitsDesign?.workflowId,
      awaitsRevision: input.awaitsDesign?.revision,
      awaitsMergeIssueId: input.awaitsMerge?.issueId,
    })
    .returning();
  if (!row) throw new Error('the question was not written');
  await emitEvent(executor, 'question.asked', {
    questionId: row.id,
    projectId: row.projectId,
    issueId: row.issueId ?? null,
  });
  return view(row);
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
  rows: Array<typeof agentQuestions.$inferInsert & { id: string }>,
): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(agentQuestions).values(rows);
  await emitEvents(
    tx,
    rows.map((r) => ({
      type: 'question.asked' as const,
      payload: { questionId: r.id, projectId: r.projectId, issueId: r.issueId ?? null },
    })),
  );
}

/** Records where answered questionnaire items landed: each row's whole landing list, as read and extended. */
export async function recordItemLandings(
  tx: Tx,
  landings: ReadonlyMap<string, QuestionnaireLanding[]>,
): Promise<void> {
  for (const [questionId, landedIn] of landings)
    await tx
      .update(agentQuestions)
      .set({ landedIn, updatedAt: new Date() })
      .where(eq(agentQuestions.id, questionId));
}
