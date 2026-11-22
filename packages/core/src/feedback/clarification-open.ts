/**
 * A clarification still open on a feedback item (REQ-66 BC-4): asked of its reporter
 * (`attachments.ts:askClarification`), it waits on that reporter's answer. The master's owed list
 * leaves such an item off (`owed-triage.ts:owedTriages`) and its standing names the reporter
 * (`standing.ts`, ISS-1382), both by this one predicate, so the pass and the read cannot disagree.
 */

import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentQuestions, type QuestionStep } from '../db/schema-questions.js';

/** The questions `on` names that are still open: an answer, or a void, closes one. */
export const clarificationOpenOn = (on: SQL) => and(on, eq(agentQuestions.status, 'open'));

/** The clarification an item waits on: the oldest still open, the one its reporter is shown (`told.ts:shownClarification`). */
export interface OpenClarification {
  round: number;
  /** When its current round was asked: since when the item waits on the answer. */
  askedAt: Date;
}

/**
 * The open clarification questions of `feedbackIds`, as one select its caller sends beside its other
 * per-item reads (`list-standing.ts:triageFactsOf`): each question's item, when it was asked and its
 * steps, folded by {@link oldestOpenOf}.
 */
export function openClarificationRows(feedbackIds: readonly string[]) {
  return db
    .select({
      feedbackId: agentQuestions.feedbackId,
      at: agentQuestions.createdAt,
      steps: agentQuestions.steps,
    })
    .from(agentQuestions)
    .where(clarificationOpenOn(inArray(agentQuestions.feedbackId, [...feedbackIds])));
}

/** Each item's oldest open clarification, by item id, from the rows {@link openClarificationRows} reads. */
export function oldestOpenOf(
  rows: readonly { feedbackId: string | null; at: Date | null; steps: QuestionStep[] | null }[],
): Map<string, OpenClarification> {
  const oldest = new Map<string, { at: Date; steps: QuestionStep[] }>();
  for (const r of rows) {
    if (!r.feedbackId || !r.steps || !r.at) continue;
    const held = oldest.get(r.feedbackId);
    if (!held || r.at.getTime() < held.at.getTime())
      oldest.set(r.feedbackId, { at: r.at, steps: r.steps });
  }
  return new Map(
    [...oldest].map(([id, { at, steps }]) => {
      const step = steps.at(-1);
      return [
        id,
        { round: step?.round ?? 1, askedAt: step?.askedAt ? new Date(step.askedAt) : at },
      ] as const;
    }),
  );
}
