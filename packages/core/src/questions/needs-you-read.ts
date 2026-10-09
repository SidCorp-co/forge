// The open questions that stand on no issue, requirement, feedback item or questionnaire: the one
// kind of question no list of work shows. A run asked it, a person owes the answer, and only the
// Agents screen can take it, so Needs you reads it from here (a question on an issue is that
// issue's standing, `holdsOpenHumanQuestion`, and a BA clarification waits on its item).

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
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

/** An open question a person owes, with the round it is on: what the needs-me read builds a decision from. */
export interface OpenPersonQuestion {
  id: string;
  issueId: string | null;
  requirementId: string | null;
  feedbackId: string | null;
  /** The round being asked, as written; null only on a row with no steps, which the read refuses. */
  current: QuestionStep;
  /** When the current round was asked, else when the question was written. */
  at: string;
}

/**
 * Every open `human` question of the project outside a questionnaire, oldest first: the answer a
 * person owes on an issue, a requirement, a feedback item or nothing, read once so each needs-me
 * decision answers the round it shows. A row with no round is a broken row and refused by id.
 */
export async function readOpenPersonQuestions(projectId: string): Promise<OpenPersonQuestion[]> {
  const rows = await db
    .select({
      id: agentQuestions.id,
      issueId: agentQuestions.issueId,
      requirementId: agentQuestions.requirementId,
      feedbackId: agentQuestions.feedbackId,
      createdAt: agentQuestions.createdAt,
      current: sql<QuestionStep | null>`${agentQuestions.steps} -> -1`,
    })
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.projectId, projectId),
        eq(agentQuestions.status, 'open'),
        eq(agentQuestions.blockerKind, 'human'),
        isNull(agentQuestions.batchId),
      ),
    )
    .orderBy(asc(agentQuestions.createdAt), asc(agentQuestions.id));
  return rows.map((r) => {
    if (!r.current) throw new Error(`questions: open question ${r.id} holds no round to answer`);
    return {
      id: r.id,
      issueId: r.issueId,
      requirementId: r.requirementId,
      feedbackId: r.feedbackId,
      current: r.current,
      at: r.current.askedAt ?? r.createdAt.toISOString(),
    };
  });
}
