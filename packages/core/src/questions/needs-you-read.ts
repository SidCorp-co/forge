// The open questions that stand on no issue, requirement, feedback item or questionnaire: the one
// kind of question no list of work shows. A run asked it, a person owes the answer, and only the
// Agents screen can take it, so Needs you reads it from here (a question on an issue is that
// issue's standing, `holdsOpenHumanQuestion`, and a BA clarification waits on its item).

import type { QuestionSuggestion } from '@forge/contracts/question-suggestion';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memoizedRead, primeReads } from '../db/read-memo.js';
import { agentQuestions, type QuestionStep } from '../db/schema-questions.js';

export interface DetachedQuestionRow {
  id: string;
  /** The current round's prompt, as the run wrote it. */
  prompt: string;
  /** When the current round was asked, else when the question was written. */
  at: string;
}

/** Every open `human` question of these projects attached to nothing, newest first. */
function detachedRowsOf(projectIds: readonly string[]) {
  return db
    .select({
      id: agentQuestions.id,
      projectId: agentQuestions.projectId,
      createdAt: agentQuestions.createdAt,
      current: sql<QuestionStep | null>`${agentQuestions.steps} -> -1`,
    })
    .from(agentQuestions)
    .where(
      and(
        inArray(agentQuestions.projectId, [...projectIds]),
        eq(agentQuestions.status, 'open'),
        eq(agentQuestions.blockerKind, 'human'),
        isNull(agentQuestions.issueId),
        isNull(agentQuestions.requirementId),
        isNull(agentQuestions.feedbackId),
        isNull(agentQuestions.batchId),
      ),
    )
    .orderBy(desc(agentQuestions.createdAt), desc(agentQuestions.id));
}

const detachedKey = (projectId: string) => `detachedOpenQuestions:${projectId}`;

/** Every open `human` question of the project attached to nothing, newest first. */
export async function readDetachedOpenQuestions(projectId: string): Promise<DetachedQuestionRow[]> {
  const rows = await memoizedRead(detachedKey(projectId), () => detachedRowsOf([projectId]));
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
  /** The assistant's record for a round, or null; the round it was drafted for decides whether it stands. */
  suggestion: QuestionSuggestion | null;
  /** When the current round was asked, else when the question was written. */
  at: string;
}

/** Every open `human` question of these projects outside a questionnaire, oldest first. */
function openPersonRowsOf(projectIds: readonly string[]) {
  return db
    .select({
      id: agentQuestions.id,
      projectId: agentQuestions.projectId,
      issueId: agentQuestions.issueId,
      requirementId: agentQuestions.requirementId,
      feedbackId: agentQuestions.feedbackId,
      createdAt: agentQuestions.createdAt,
      suggestion: agentQuestions.suggestion,
      current: sql<QuestionStep | null>`${agentQuestions.steps} -> -1`,
    })
    .from(agentQuestions)
    .where(
      and(
        inArray(agentQuestions.projectId, [...projectIds]),
        eq(agentQuestions.status, 'open'),
        eq(agentQuestions.blockerKind, 'human'),
        isNull(agentQuestions.batchId),
      ),
    )
    .orderBy(asc(agentQuestions.createdAt), asc(agentQuestions.id));
}

const openPersonKey = (projectId: string) => `openPersonQuestions:${projectId}`;

/**
 * Both open-question reads of every project in `projectIds`, one statement each, answering each
 * project's own read later in the request (`db/read-memo.ts:primeReads`).
 */
export function primeOpenQuestionReads(projectIds: readonly string[]): void {
  primeReads(projectIds, detachedKey, detachedRowsOf, (r) => r.projectId);
  primeReads(projectIds, openPersonKey, openPersonRowsOf, (r) => r.projectId);
}

/**
 * Every open `human` question of the project outside a questionnaire, oldest first: the answer a
 * person owes on an issue, a requirement, a feedback item or nothing, read once so each needs-me
 * decision answers the round it shows. A row with no round is a broken row and refused by id.
 */
export async function readOpenPersonQuestions(projectId: string): Promise<OpenPersonQuestion[]> {
  const rows = await memoizedRead(openPersonKey(projectId), () => openPersonRowsOf([projectId]));
  return rows.map((r) => {
    if (!r.current) throw new Error(`questions: open question ${r.id} holds no round to answer`);
    return {
      id: r.id,
      issueId: r.issueId,
      requirementId: r.requirementId,
      feedbackId: r.feedbackId,
      current: r.current,
      suggestion: r.suggestion,
      at: r.current.askedAt ?? r.createdAt.toISOString(),
    };
  });
}
