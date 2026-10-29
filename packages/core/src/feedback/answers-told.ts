/**
 * Which answers a reporter's own sessions have been told (REQ-47 BC-11). An answer is a `triaged`
 * decision on the `answer` route; the one an item stands on is its latest, while its route is still
 * `answer`. A reporter is told each such answer once: the claim that hands it to a session records it
 * in the same statement, so two sessions asking at once are never both handed it, and a later answer
 * on the same item is a new decision to tell.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedback, feedbackAnswerDeliveries, feedbackDecisions } from '../db/schema-feedback.js';

export interface UntoldAnswer {
  feedbackId: string;
  fbSeq: number;
  decisionId: string;
  answeredAt: Date;
}

/** The answer each of `ids` stands on that `userId` has not been told, oldest answer first. */
export async function untoldAnswersOf(
  ids: readonly string[],
  userId: string,
): Promise<UntoldAnswer[]> {
  if (ids.length === 0) return [];
  const standing = await db
    .selectDistinctOn([feedbackDecisions.feedbackId], {
      feedbackId: feedbackDecisions.feedbackId,
      fbSeq: feedback.fbSeq,
      decisionId: feedbackDecisions.id,
      answeredAt: feedbackDecisions.decidedAt,
    })
    .from(feedbackDecisions)
    .innerJoin(feedback, eq(feedback.id, feedbackDecisions.feedbackId))
    .where(
      and(
        inArray(feedbackDecisions.feedbackId, [...ids]),
        eq(feedbackDecisions.decision, 'triaged'),
        eq(feedbackDecisions.route, 'answer'),
        eq(feedback.route, 'answer'),
      ),
    )
    .orderBy(feedbackDecisions.feedbackId, desc(feedbackDecisions.decidedAt));
  if (standing.length === 0) return [];
  const told = await db
    .select({ decisionId: feedbackAnswerDeliveries.decisionId })
    .from(feedbackAnswerDeliveries)
    .where(
      and(
        eq(feedbackAnswerDeliveries.userId, userId),
        inArray(
          feedbackAnswerDeliveries.decisionId,
          standing.map((s) => s.decisionId),
        ),
      ),
    );
  const done = new Set(told.map((t) => t.decisionId));
  return standing
    .filter((s) => !done.has(s.decisionId))
    .sort((a, b) => a.answeredAt.getTime() - b.answeredAt.getTime());
}

/**
 * Record `decisionIds` as told to `userId`'s session, and answer which of them this call recorded: one
 * another session claimed first is left out, so each answer is handed to one session once.
 */
export async function claimAnswersTold(
  decisionIds: readonly string[],
  userId: string,
): Promise<Set<string>> {
  if (decisionIds.length === 0) return new Set();
  const written = await db
    .insert(feedbackAnswerDeliveries)
    .values(decisionIds.map((decisionId) => ({ decisionId, userId, via: 'session' as const })))
    .onConflictDoNothing()
    .returning({ decisionId: feedbackAnswerDeliveries.decisionId });
  return new Set(written.map((w) => w.decisionId));
}
