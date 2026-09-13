// Asking a question as somebody, reading one as somebody, answering one as somebody.
//
// Everything here answers from a ROW. The websocket tells a box to look; it
// never carries the answer, so a box offline for the whole episode loses
// latency and nothing else (ISS-964 criterion 12).

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, type ProjectMemberRole } from '../db/schema.js';
import {
  agentQuestions,
  type QuestionBlockerKind,
  type QuestionOption,
  type QuestionStatus,
  type QuestionStep,
  questionWaiters,
} from '../db/schema-questions.js';
import { effectiveProjectRole, projectRoleAtLeast } from '../lib/authz.js';
import { answerQuestion, askQuestion, mayChoose, QuestionRefused } from './write.js';

export type VisibleOption = QuestionOption & { locked: boolean };

// cm:guard a null ROLE is refused as hard as a null access. `effectiveProjectRole` answers `{ role: null }` — not `null` — for a signed-in caller who is neither a project member nor an org member of the owning org, so the earlier `if (!access)` handed that caller the whole question row of any project in the fleet (ISS-980).
async function roleOn(projectId: string, userId: string): Promise<ProjectMemberRole | null> {
  const access = await effectiveProjectRole(userId, projectId);
  return access?.role ?? null;
}

// cm:guard visibility and choosability are SEPARATE. Any member of the project opens the question and reads every option; `authority: admin` locks the CHOICE alone. A question hidden from a writer is the failure criterion 15 names, and it is the one that leaves a queue of decisions only one person can even look at.
function seenBy<T extends { steps: QuestionStep[] }>(row: T, role: ProjectMemberRole | null) {
  const current = row.steps[row.steps.length - 1];
  const options: VisibleOption[] = (current?.options ?? []).map((o) => ({
    ...o,
    locked: !mayChoose(o, role),
  }));
  return { ...row, options, recommendedOptionId: current?.recommendedOptionId ?? '' };
}

/**
 * Ask a question against one issue, as somebody, or `null` when that somebody
 * cannot reach the issue.
 */
// cm:guard the project is READ OFF THE ISSUE and never taken from the caller, so a row whose `project_id` and `issue_id` name different projects is unrepresentable through this door rather than merely refused — `QUESTION_ISSUE_ELSEWHERE` is unreachable from here, and an issue this caller may not reach is the same `null` as an issue that does not exist (ISS-989).
// cm:guard core allocates the id HERE and the runner still mints its own on `POST /api/devices/me/questions`, which is the difference between a caller that has already written half a park locally and one that has not. The guard on `agentQuestions.id` carries which door does which.
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
    options: args.options,
    recommendedOptionId: args.recommendedOptionId,
    ...(args.assumed ? { assumed: args.assumed } : {}),
    ...(args.maxRounds === undefined ? {} : { maxRounds: args.maxRounds }),
    ...(args.parkDeadlineAt ? { parkDeadlineAt: args.parkDeadlineAt } : {}),
  });
}

/**
 * Every question of one project, newest first, or null when the caller cannot
 * reach the project.
 */
// cm:guard the `id` tie-break is what makes the order total: two questions asked in the same transaction share a `created_at` to the microsecond, and an order that leaves them free reads a different queue on each call, which is the one thing a caller draining "what is waiting" cannot work with (the same pair `readQuestionsForIssue` orders by).
export async function projectQuestionsFor(
  projectId: string,
  userId: string,
  status?: QuestionStatus,
) {
  const role = await roleOn(projectId, userId);
  if (!role) return null;
  const rows = await db
    .select()
    .from(agentQuestions)
    .where(
      status
        ? and(eq(agentQuestions.projectId, projectId), eq(agentQuestions.status, status))
        : eq(agentQuestions.projectId, projectId),
    )
    .orderBy(desc(agentQuestions.createdAt), desc(agentQuestions.id));
  return rows.map((row) => seenBy(row, role));
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
// cm:guard authorised against the ISSUE's project and never against the questions it happens to carry, so an issue with no question answers an empty LIST to a member and `null` to a stranger — collapsing those two makes "you may not look" indistinguishable from "there is nothing to look at" (ISS-980 criteria 20, 22).
// cm:guard the SELECT carries the project too, and the role check above does not stand in for it: `project_id` and `issue_id` are independent columns, so a row naming project A on an issue of project B is representable, and on `issue_id` alone this hands that row — `steps`, every prompt and option of A's decision — to the B member the role check just cleared (ISS-989).
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

// cm:guard the ROLE is resolved here and handed down; the option it governs is read inside `answerQuestion`'s row lock. Authorization stays request-time, as on every other route — locking `agent_questions` does not lock `project_members`, so resolving the role under that lock would buy nothing and cost a join under it.
export async function answerAs(args: {
  questionId: string;
  optionId: string;
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
    optionId: args.optionId,
    round: args.round,
    by: args.userId,
    role,
  });
}

/**
 * The answer on the record, readable as many times as anyone asks.
 */
// cm:guard the answer is NOT consumed by the read. A revival cancelled by a fence must leave it in place for whoever continues, and a read that cleared it would ask the human the same question again (ISS-964 criterion 18).
export async function answerOf(questionId: string) {
  const [row] = await db
    .select()
    .from(agentQuestions)
    .where(eq(agentQuestions.id, questionId))
    .limit(1);
  const answered = row?.steps.filter((s) => s.chosenOptionId).at(-1);
  if (!answered?.chosenOptionId) return null;
  return {
    questionId,
    optionId: answered.chosenOptionId,
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
