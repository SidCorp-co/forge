/**
 * A clarification still open on a feedback item (REQ-66 BC-4): asked of its reporter
 * (`attachments.ts:askClarification`), it waits on that reporter's answer. The master's owed list
 * leaves such an item off (`owed-triage.ts:owedTriages`) and its standing names the reporter
 * (`standing.ts`, ISS-1382), both by this one predicate, so the pass and the read cannot disagree.
 */

import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memoizedPerId } from '../db/read-memo.js';
import { agentQuestions } from '../db/schema-questions.js';

/** The questions `on` names that are still open: an answer, or a void, closes one. */
export const clarificationOpenOn = (on: SQL) => and(on, eq(agentQuestions.status, 'open'));

/** The clarification an item waits on: the oldest still open, the one its reporter is shown (`told.ts:shownClarification`). */
export interface OpenClarification {
  round: number;
  /** When its current round was asked: since when the item waits on the answer. */
  askedAt: Date;
}

/** The open clarification of each of `feedbackIds` that has one, by item id. */
export function openClarificationsOf(
  feedbackIds: readonly string[],
): Promise<Map<string, OpenClarification>> {
  return memoizedPerId('feedbackOpenClarification', feedbackIds, async (some) => {
    if (some.length === 0) return new Map();
    const rows = await db
      .select({
        feedbackId: agentQuestions.feedbackId,
        steps: agentQuestions.steps,
        createdAt: agentQuestions.createdAt,
      })
      .from(agentQuestions)
      .where(clarificationOpenOn(inArray(agentQuestions.feedbackId, [...some])))
      .orderBy(asc(agentQuestions.createdAt));
    const out = new Map<string, OpenClarification>();
    for (const r of rows) {
      if (!r.feedbackId || out.has(r.feedbackId)) continue;
      const step = r.steps.at(-1);
      out.set(r.feedbackId, {
        round: step?.round ?? 1,
        askedAt: step?.askedAt ? new Date(step.askedAt) : r.createdAt,
      });
    }
    return out;
  });
}
