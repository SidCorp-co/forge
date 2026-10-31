/**
 * Whether an item was triaged or declined after a moment (ISS-832): what a `feedback_triage`
 * suggestion made before that is judged stale by, at its accept.
 */

import { feedbackKey } from '@forge/contracts/feedback';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { feedback, feedbackDecisions } from '../db/schema-feedback.js';

export interface TriagedSince {
  key: string;
  decision: 'triaged' | 'declined';
  route: string | null;
  at: Date;
}

/** The latest triage or decline of `feedbackId` decided after `since`, or null where none was. */
export async function triagedSince(
  tx: Tx,
  feedbackId: string,
  since: Date,
): Promise<TriagedSince | null> {
  const [found] = await tx
    .select({
      fbSeq: feedback.fbSeq,
      decision: feedbackDecisions.decision,
      route: feedbackDecisions.route,
      at: feedbackDecisions.decidedAt,
    })
    .from(feedbackDecisions)
    .innerJoin(feedback, eq(feedback.id, feedbackDecisions.feedbackId))
    .where(
      and(
        eq(feedbackDecisions.feedbackId, feedbackId),
        inArray(feedbackDecisions.decision, ['triaged', 'declined']),
        gt(feedbackDecisions.decidedAt, since),
      ),
    )
    .orderBy(desc(feedbackDecisions.decidedAt))
    .limit(1);
  if (!found) return null;
  return {
    key: feedbackKey(found.fbSeq),
    decision: found.decision as 'triaged' | 'declined',
    route: found.route,
    at: found.at,
  };
}
