// Asking a question as somebody, reading one as somebody, answering one as somebody.
//
// Everything here answers from a ROW. The websocket tells a box to look; it
// never carries the answer, so a box offline for the whole episode loses
// latency and nothing else (ISS-964 criterion 12).

import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, type ProjectMemberRole } from '../db/schema.js';
import {
  type AnswerShape,
  agentQuestions,
  isChoiceStep,
  type QuestionBlockerKind,
  type QuestionOption,
  type QuestionStatus,
  type QuestionStep,
  questionWaiters,
} from '../db/schema-questions.js';
import { effectiveProjectRole, projectRoleAtLeast } from '../lib/authz.js';
import {
  answerQuestion,
  askQuestion,
  type GivenAnswer,
  mayAnswerFreeText,
  mayChoose,
  QuestionRefused,
} from './write.js';

export type VisibleOption = QuestionOption & { locked: boolean };

async function roleOn(projectId: string, userId: string): Promise<ProjectMemberRole | null> {
  const access = await effectiveProjectRole(userId, projectId);
  return access?.role ?? null;
}

function shapeOf(current: QuestionStep | undefined, role: ProjectMemberRole | null) {
  const choice = current ? isChoiceStep(current) : true;
  const options: VisibleOption[] =
    current && isChoiceStep(current)
      ? current.options.map((o) => ({ ...o, locked: !mayChoose(o, role) }))
      : [];
  return {
    answerShape: (choice ? 'choice' : 'free_text') satisfies AnswerShape as AnswerShape,
    options,
    recommendedOptionId: current && isChoiceStep(current) ? current.recommendedOptionId : '',
    needed: current && !isChoiceStep(current) ? current.needed : '',
    locked: choice ? false : !mayAnswerFreeText(role),
    prompt: current?.prompt ?? '',
    round: current?.round ?? 0,
    askedAt: current?.askedAt ?? '',
  };
}

function seenBy<T extends { steps: QuestionStep[] }>(row: T, role: ProjectMemberRole | null) {
  return { ...row, ...shapeOf(row.steps[row.steps.length - 1], role) };
}

/**
 * Ask a question against one issue, as somebody, or `null` when that somebody
 * cannot reach the issue.
 */
export type AskAsInput = {
  userId: string;
  issueId: string;
  prompt: string;
  blockerKind: QuestionBlockerKind;
  options: QuestionOption[];
  recommendedOptionId: string;
  assumed?: Record<string, unknown> | undefined;
  maxRounds?: number | undefined;
  parkDeadlineAt?: Date | undefined;
};

export async function askAs(args: AskAsInput) {
  const [issue] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, args.issueId))
    .limit(1);
  if (!issue?.projectId) return null;
  const role = await roleOn(issue.projectId, args.userId);
  if (!role) return null;
  if (!projectRoleAtLeast(role, 'member')) {
    throw new QuestionRefused(
      'asking a question writes a row, and this caller is a viewer on the project the issue belongs to',
    );
  }
  return askQuestion({
    id: randomUUID(),
    projectId: issue.projectId,
    issueId: args.issueId,
    prompt: args.prompt,
    blockerKind: args.blockerKind,
    answer: {
      shape: 'choice',
      options: args.options,
      recommendedOptionId: args.recommendedOptionId,
    },
    ...(args.assumed ? { assumed: args.assumed } : {}),
    ...(args.maxRounds === undefined ? {} : { maxRounds: args.maxRounds }),
    ...(args.parkDeadlineAt ? { parkDeadlineAt: args.parkDeadlineAt } : {}),
  });
}

/**
 * One page of a project's questions, newest first, or null when the caller
 * cannot reach the project.
 */
export type ProjectQuestionPage = {
  questions: Array<ReturnType<typeof shapeOf> & Record<string, unknown>>;
  total: number;
  hasMore: boolean;
  /** Where the next page starts, as the last row's own `(created_at, id)`. Null on the last page. */
  nextCursor: string | null;
};

/** One page's starting point: base64url over `<created_at microseconds>|<id>` — the order key itself, not a count. */
export type QuestionCursor = string;

const CURSOR_KEY =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::\d{2})?)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function encodeCursor(key: string): QuestionCursor {
  return Buffer.from(key, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { at: string; id: string } | null {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const m = CURSOR_KEY.exec(raw);
  return m?.[1] && m[2] ? { at: m[1], id: m[2] } : null;
}

function cursorPredicate(cursor: QuestionCursor | undefined) {
  if (!cursor) return undefined;
  const key = decodeCursor(cursor);
  if (!key) {
    throw new QuestionRefused(
      'the cursor does not decode to a `(created_at, id)` key: send back the `nextCursor` of the previous page exactly as it arrived',
      'QUESTION_CURSOR_INVALID',
    );
  }
  return sql`(${agentQuestions.createdAt}, ${agentQuestions.id}) < (${key.at}::timestamptz, ${key.id}::uuid)`;
}

export async function projectQuestionsFor(
  projectId: string,
  userId: string,
  status?: QuestionStatus,
  page: { limit: number; cursor?: QuestionCursor | undefined } = { limit: 50 },
): Promise<ProjectQuestionPage | null> {
  const role = await roleOn(projectId, userId);
  if (!role) return null;
  const scope = status
    ? and(eq(agentQuestions.projectId, projectId), eq(agentQuestions.status, status))
    : eq(agentQuestions.projectId, projectId);
  const after = cursorPredicate(page.cursor);
  const where = after ? and(scope, after) : scope;

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id: agentQuestions.id,
        projectId: agentQuestions.projectId,
        issueId: agentQuestions.issueId,
        agentSessionId: agentQuestions.agentSessionId,
        status: agentQuestions.status,
        blockerKind: agentQuestions.blockerKind,
        maxRounds: agentQuestions.maxRounds,
        assumed: agentQuestions.assumed,
        voidReason: agentQuestions.voidReason,
        claimsHeld: agentQuestions.claimsHeld,
        workspacesPinned: agentQuestions.workspacesPinned,
        dependents: agentQuestions.dependents,
        parkDeadlineAt: agentQuestions.parkDeadlineAt,
        endedBy: agentQuestions.endedBy,
        endedReason: agentQuestions.endedReason,
        createdAt: agentQuestions.createdAt,
        updatedAt: agentQuestions.updatedAt,
        rounds: sql<number>`jsonb_array_length(${agentQuestions.steps})::int`,
        currentStep: sql<QuestionStep | null>`${agentQuestions.steps} -> -1`,
        cursor: sql<string>`${agentQuestions.createdAt}::text || '|' || ${agentQuestions.id}::text`,
      })
      .from(agentQuestions)
      .where(where)
      .orderBy(desc(agentQuestions.createdAt), desc(agentQuestions.id))
      .limit(page.limit + 1),
    db.select({ n: count() }).from(agentQuestions).where(scope),
  ]);

  const total = Number(totalRow?.n ?? 0);
  const hasMore = rows.length > page.limit;
  const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    questions: pageRows.map(({ cursor: _cursor, ...row }) => ({
      ...row,
      rounds: Number(row.rounds),
      ...shapeOf(row.currentStep ?? undefined, role),
    })),
    total,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last.cursor) : null,
  };
}

export async function readQuestionFor(questionId: string, userId: string) {
  const [row] = await db
    .select()
    .from(agentQuestions)
    .where(eq(agentQuestions.id, questionId))
    .limit(1);
  if (!row?.projectId) return null;
  const role = await roleOn(row.projectId, userId);
  if (!role) return null;
  return seenBy(row, role);
}

/**
 * Every question on one issue, newest first, or null when the caller cannot reach it.
 */
export async function readQuestionsForIssue(issueId: string, userId: string) {
  const [issue] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!issue?.projectId) return null;
  const role = await roleOn(issue.projectId, userId);
  if (!role) return null;
  const rows = await db
    .select()
    .from(agentQuestions)
    .where(and(eq(agentQuestions.issueId, issueId), eq(agentQuestions.projectId, issue.projectId)))
    .orderBy(desc(agentQuestions.createdAt), desc(agentQuestions.id));
  return rows.map((row) => seenBy(row, role));
}

export async function answerAs(args: {
  questionId: string;
  answer: GivenAnswer;
  round: number;
  userId: string;
}) {
  const [row] = await db
    .select({ projectId: agentQuestions.projectId })
    .from(agentQuestions)
    .where(eq(agentQuestions.id, args.questionId))
    .limit(1);
  if (!row?.projectId) {
    throw new QuestionRefused(`no question ${args.questionId}`, 'QUESTION_NOT_FOUND');
  }
  const role = await roleOn(row.projectId, args.userId);
  if (!role) throw new QuestionRefused(`no question ${args.questionId}`, 'QUESTION_NOT_FOUND');
  return answerQuestion({
    questionId: args.questionId,
    answer: args.answer,
    round: args.round,
    by: args.userId,
    role,
  });
}

/**
 * The answer on the record, readable as many times as anyone asks.
 */
export async function answerOf(questionId: string) {
  const [row] = await db
    .select()
    .from(agentQuestions)
    .where(eq(agentQuestions.id, questionId))
    .limit(1);
  const answered = row?.steps.filter((s) => s.answeredAt).at(-1);
  if (!answered?.answeredAt) return null;
  const choice = isChoiceStep(answered);
  return {
    questionId,
    answerShape: (choice ? 'choice' : 'free_text') satisfies AnswerShape as AnswerShape,
    optionId: choice ? (answered.chosenOptionId ?? null) : null,
    text: choice ? null : (answered.answerText ?? null),
    answeredAt: answered.answeredAt,
    answeredBy: answered.answeredBy,
    round: answered.round,
  };
}

export async function registerWaiter(args: {
  questionId: string;
  deviceId: string;
  runId: string;
}) {
  await db.insert(questionWaiters).values(args).onConflictDoNothing();
}

export async function waitersOf(questionId: string) {
  return db.select().from(questionWaiters).where(eq(questionWaiters.questionId, questionId));
}

export async function waiterFor(args: { questionId: string; deviceId: string; runId: string }) {
  const [row] = await db
    .select()
    .from(questionWaiters)
    .where(
      and(
        eq(questionWaiters.questionId, args.questionId),
        eq(questionWaiters.deviceId, args.deviceId),
        eq(questionWaiters.runId, args.runId),
      ),
    )
    .limit(1);
  return row ?? null;
}
