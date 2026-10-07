// The open questions that stand on no issue, requirement, feedback item or questionnaire: the one
// kind of question no list of work shows. A run asked it, a person owes the answer, and only the
// Agents screen can take it, so Needs you reads it from here (a question on an issue is that
// issue's standing, `holdsOpenHumanQuestion`, and a BA clarification waits on its item).

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentQuestions, type QuestionStep } from '../db/schema-questions.js';

export interface DetachedQuestionRow {
  id: string;
  /** The current round's prompt, as the run wrote it. */
  prompt: string;
  /** When the current round was asked, else when the question was written. */
  at: string;
}

/** Every open `human` question of the project attached to nothing, newest first. */
export async function readDetachedOpenQuestions(projectId: string): Promise<DetachedQuestionRow[]> {
  const rows = await db
    .select({
      id: agentQuestions.id,
      createdAt: agentQuestions.createdAt,
      current: sql<QuestionStep | null>`${agentQuestions.steps} -> -1`,
    })
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.projectId, projectId),
        eq(agentQuestions.status, 'open'),
        eq(agentQuestions.blockerKind, 'human'),
        isNull(agentQuestions.issueId),
        isNull(agentQuestions.requirementId),
        isNull(agentQuestions.feedbackId),
        isNull(agentQuestions.batchId),
      ),
    )
    .orderBy(desc(agentQuestions.createdAt), desc(agentQuestions.id));
  return rows.map((r) => ({
    id: r.id,
    prompt: r.current?.prompt ?? '',
    at: r.current?.askedAt ?? r.createdAt.toISOString(),
  }));
}
