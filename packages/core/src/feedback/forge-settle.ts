/**
 * The reporter of an item about Forge confirms its shipped fix or reopens it through the Forge door
 * (REQ-66 BC-8), as a person does on the item's page: the same move under the same rules
 * (`service.ts:personalActIn`), and an agent with what it ran and saw. The reporter need not be a
 * member of the home project (REQ-47 BC-3), so the door checks that the item is its own instead.
 */

import { feedbackKey } from '@forge/contracts/feedback';
import type { Refusal } from '../lib/refusal.js';
import { forgeRefusal } from './forge-intake.js';
import { type FeedbackActor, rowIn } from './read.js';
import { inTx, lockFeedback, personalActIn } from './service.js';

/** The door's own field for what the REST door takes as a verify's note or a reopen's reason. */
const ON_EVIDENCE: ReadonlySet<string> = new Set([
  'FEEDBACK_EVIDENCE_REQUIRED',
  'FEEDBACK_REOPEN_REASON_REQUIRED',
]);

export async function settleOwnForgeFeedback(input: {
  homeId: string;
  feedbackId: string;
  actor: FeedbackActor;
  act: 'verified' | 'reopened';
  evidence: string | undefined;
}): Promise<Refusal[] | null> {
  const { homeId, actor } = input;
  return inTx(async (tx) => {
    await lockFeedback(tx, homeId);
    const row = await rowIn(tx, homeId, input.feedbackId, true);
    if (row.reportedBy !== actor.userId) {
      return [
        forgeRefusal(
          'FORGE_FEEDBACK_NOT_YOURS',
          '/feedback',
          `${feedbackKey(row.fbSeq)} was filed by another account; only its reporter confirms or reopens it here.`,
        ),
      ];
    }
    const refused = await personalActIn(tx, row, actor, input.act, input.evidence);
    if (!refused) return null;
    return [ON_EVIDENCE.has(refused.code) ? { ...refused, path: '/evidence' } : refused];
  });
}
