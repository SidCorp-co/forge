// Reading a question as somebody, and answering it as somebody.
//
// Everything here answers from a ROW. The websocket tells a box to look; it
// never carries the answer, so a box offline for the whole episode loses
// latency and nothing else (ISS-964 criterion 12).

import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, type ProjectMemberRole } from '../db/schema.js';
import {
  agentQuestions,
  type QuestionOption,
  type QuestionStep,
  questionWaiters,
} from '../db/schema-questions.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { answerQuestion, mayChoose, QuestionRefused } from './write.js';

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
