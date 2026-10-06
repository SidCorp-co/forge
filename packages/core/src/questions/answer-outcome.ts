// What an answer did to the issue it stopped, kept on the answered round (ISS-258): the answer
// resume writes it, and the park view and the standing read it, so a park an answer did not move
// names why instead of reading as still owed an answer.

import type { AnswerHold, AnswerResume } from '@forge/contracts/questions';
import { and, desc, eq, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentQuestions, type QuestionStep } from '../db/schema-questions.js';
import type { IssueDependencyExecutor } from '../issues/index.js';

/** The answered round of one question as the resume reads it: what it holds the issue on, if anything. */
export async function answeredHoldOf(questionId: string): Promise<AnswerHold | null> {
  const [row] = await db
    .select({ steps: agentQuestions.steps })
    .from(agentQuestions)
    .where(eq(agentQuestions.id, questionId))
    .limit(1);
  return row?.steps.at(-1)?.hold ?? null;
}

/**
 * Record on the question's last round what its answer did to the issue. A later outcome for the
 * same answer (a lapsed send decided afterwards) replaces the earlier one.
 */
export async function recordAnswerResume(
  questionId: string,
  resume: AnswerResume,
  executor: IssueDependencyExecutor = db,
): Promise<void> {
  await executor
    .update(agentQuestions)
    .set({
      steps: sql`jsonb_set(${agentQuestions.steps}, array[(jsonb_array_length(${agentQuestions.steps}) - 1)::text, 'resume'], ${JSON.stringify(resume)}::jsonb)`,
    })
    .where(and(eq(agentQuestions.id, questionId), eq(agentQuestions.status, 'answered')));
}

export interface AnsweredSince {
  questionId: string;
  answeredAt: string;
  hold: AnswerHold | null;
  resume: AnswerResume | null;
}

/** The question on this issue answered most recently after `after` (any time, where null). */
export async function answeredSince(
  executor: IssueDependencyExecutor,
  issueId: string,
  after: Date | null,
): Promise<AnsweredSince | null> {
  const answeredAt = sql<string>`${agentQuestions.steps} -> -1 ->> 'answeredAt'`;
  const rows = await executor
    .select({ id: agentQuestions.id, steps: agentQuestions.steps })
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.issueId, issueId),
        eq(agentQuestions.status, 'answered'),
        after ? sql`(${answeredAt})::timestamptz > ${after.toISOString()}::timestamptz` : sql`true`,
      ),
    )
    .orderBy(desc(answeredAt), desc(agentQuestions.id))
    .limit(1);
  const row = rows[0];
  const step: QuestionStep | undefined = row?.steps.at(-1);
  if (!row || !step?.answeredAt) return null;
  return {
    questionId: row.id,
    answeredAt: step.answeredAt,
    hold: step.hold ?? null,
    resume: step.resume ?? null,
  };
}

/**
 * The same read as SQL for a page of issues: `{ questionId, answeredAt, hold, resume }` of the
 * question answered most recently after `after`, or null.
 */
export function answeredSinceSql(issueId: SQLWrapper, after: SQLWrapper): SQL {
  return sql`(SELECT jsonb_build_object('questionId', q.id, 'answeredAt', q.steps -> -1 ->> 'answeredAt',
                     'hold', q.steps -> -1 -> 'hold', 'resume', q.steps -> -1 -> 'resume')
                FROM agent_questions q
               WHERE q.issue_id = ${issueId} AND q.status = 'answered'
                 AND (${after} IS NULL OR (q.steps -> -1 ->> 'answeredAt')::timestamptz > ${after})
               ORDER BY q.steps -> -1 ->> 'answeredAt' DESC, q.id DESC LIMIT 1)`;
}
