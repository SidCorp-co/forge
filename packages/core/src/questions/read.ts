// Reading a question as somebody, and answering it as somebody.
//
// Everything here answers from a ROW. The websocket tells a box to look; it
// never carries the answer, so a box offline for the whole episode loses
// latency and nothing else (ISS-964 criterion 12).

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentQuestions, type QuestionOption, questionWaiters } from '../db/schema-questions.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { answerQuestion, QuestionRefused } from './write.js';

export type VisibleOption = QuestionOption & { locked: boolean };

// cm:guard visibility and choosability are SEPARATE. Any member of the project opens the question and reads every option; `authority: admin` locks the CHOICE alone. A question hidden from a writer is the failure criterion 15 names, and it is the one that leaves a queue of decisions only one person can even look at.
export async function readQuestionFor(questionId: string, userId: string) {
  const [row] = await db
    .select()
    .from(agentQuestions)
    .where(eq(agentQuestions.id, questionId))
    .limit(1);
  if (!row?.projectId) return null;
  const access = await effectiveProjectRole(userId, row.projectId);
  if (!access) return null;
  const current = row.steps[row.steps.length - 1];
  const options: VisibleOption[] = (current?.options ?? []).map((o) => ({
    ...o,
    locked: !mayChoose(o, access.role),
  }));
  return { ...row, options, recommendedOptionId: current?.recommendedOptionId ?? '' };
}

function mayChoose(option: QuestionOption, role: string | null) {
  if (role === 'viewer') return false;
  return option.authority === 'writer' || role === 'admin';
}

export async function answerAs(args: { questionId: string; optionId: string; userId: string }) {
  const seen = await readQuestionFor(args.questionId, args.userId);
  if (!seen) throw new QuestionRefused(`no question ${args.questionId}`);
  const option = seen.options.find((o) => o.id === args.optionId);
  if (!option) throw new QuestionRefused('that option is not on the open round of this question');
  if (option.locked) {
    throw new QuestionRefused(
      `option ${option.id} carries authority ${option.authority} and this caller may not choose it`,
    );
  }
  return answerQuestion({ questionId: args.questionId, optionId: args.optionId, by: args.userId });
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
