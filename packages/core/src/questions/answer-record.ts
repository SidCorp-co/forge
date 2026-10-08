// The record an answer leaves on the issue its question stopped: the answer moved the park (or held
// it) with no comment and no issue event, so a master reading the thread or the events kept
// reporting six answered questions as owner-pending (hop, 2026-10-07). Written in the answer's own
// transaction, by every door that answers one: a person's answer, and each fact a park waits on (a
// design decision, a merge mark), which answers through `answerWaitingQuestions` below.

import type { ActorAgency } from '@forge/contracts/permissions';
import { QUESTION_MACHINE } from '@forge/contracts/question-machine';
import type { AnswerHold } from '@forge/contracts/questions';
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { agentQuestions, isChoiceStep, type QuestionStep } from '../db/schema-questions.js';
import { writeRecordEvent } from '../issues/index.js';
import { transition } from '../lifecycle/index.js';
import { emitEvent } from '../outbox/index.js';

export async function recordAnswerOnIssue(
  tx: Tx,
  args: {
    issueId: string | null;
    questionId: string;
    round: number;
    answer: string;
    by: string;
    agency: ActorAgency;
    hold?: AnswerHold | undefined;
  },
): Promise<void> {
  if (!args.issueId) return;
  const field = (key: string, value: string | undefined) =>
    value === undefined || value === '' ? [] : [{ key, value }];
  await writeRecordEvent(
    {
      issueId: args.issueId,
      actor: { type: 'user', id: args.by, agency: args.agency },
      kind: 'answer',
      contract: 1,
      fields: [
        { key: 'question', value: args.questionId },
        { key: 'round', value: String(args.round) },
        ...field('answer', args.answer),
        ...field('still-waits', args.hold?.reason),
        ...field('blocked-by', args.hold?.blockedBy?.key),
      ],
    },
    tx,
  );
}

/**
 * Answer open park questions with the fact that settles them, as `by` answered: each one's free-text
 * round takes `body`, the question moves to answered, the issue it stopped records the answer, and
 * `question.answered` carries it to the consumers a person's answer reaches. The one writer for every
 * fact a park can wait on (a design decision, a merge mark), called in that fact's own transaction.
 */
export async function answerWaitingQuestions(
  tx: Tx,
  rows: readonly (typeof agentQuestions.$inferSelect)[],
  args: { body: string; by: string; agency: ActorAgency; source: string; waitsOn: string },
): Promise<string[]> {
  const now = new Date();
  for (const row of rows) {
    const current = row.steps[row.steps.length - 1];
    if (!current || isChoiceStep(current)) {
      throw new Error(
        `questions: question ${row.id} waits on ${args.waitsOn} and its round is not free text — only a park writes that link, and a park asks in free text`,
      );
    }
    const answered: QuestionStep = {
      ...current,
      answeredAt: now.toISOString(),
      answerText: args.body,
      answeredBy: args.by,
    };
    const steps = row.steps.map((s, i) => (i === row.steps.length - 1 ? answered : s));
    await transition(tx, QUESTION_MACHINE, {
      to: 'answered',
      from: 'open',
      set: { steps, updatedAt: now },
      where: eq(agentQuestions.id, row.id),
      actor: { type: 'user', id: args.by, agency: args.agency },
      source: args.source,
      returning: ['id'],
    });
    await recordAnswerOnIssue(tx, {
      issueId: row.issueId ?? null,
      questionId: row.id,
      round: answered.round,
      answer: args.body,
      by: args.by,
      agency: args.agency,
    });
    await emitEvent(tx, 'question.answered', {
      questionId: row.id,
      projectId: row.projectId,
      issueId: row.issueId ?? null,
      answeredBy: args.by,
      body: args.body,
    });
  }
  return rows.map((r) => r.id);
}
