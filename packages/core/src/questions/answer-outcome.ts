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

/** A question on an issue answered after a moment, as the pass nudge names it. */
export interface AnsweredOnIssue {
  questionId: string;
  issueId: string;
  issSeq: number;
  issuePrefix: string | null;
  answeredAt: string;
  resume: AnswerResume | null;
}

/** Every question on an issue of this project answered after `after`, oldest answer first. */
export async function answeredOnIssuesSince(
  projectId: string,
  after: Date,
): Promise<AnsweredOnIssue[]> {
  const rows = (await db.execute(sql`
    SELECT q.id AS question_id, i.id AS issue_id, i.iss_seq, p.issue_prefix,
           q.steps -> -1 ->> 'answeredAt' AS answered_at, q.steps -> -1 -> 'resume' AS resume
      FROM agent_questions q
      JOIN issues i ON i.id = q.issue_id
      JOIN projects p ON p.id = i.project_id
     WHERE q.project_id = ${projectId} AND q.status = 'answered'
       AND (q.steps -> -1 ->> 'answeredAt')::timestamptz > ${after.toISOString()}::timestamptz
     ORDER BY (q.steps -> -1 ->> 'answeredAt')::timestamptz, q.id
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    questionId: String(r.question_id),
    issueId: String(r.issue_id),
    issSeq: Number(r.iss_seq),
    issuePrefix: (r.issue_prefix as string | null) ?? null,
    answeredAt: String(r.answered_at),
    resume: (r.resume as AnswerResume | null) ?? null,
  }));
}
