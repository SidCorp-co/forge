/**
 * The reporter's reply to an answer, through the Forge door (REQ-47 r2 BC-12): once per answer, with
 * its evidence, and it sends the item back to triage as a reopen does — the same edge, its own
 * decision. The reopen or reply an item stands on is what its next answer names (BC-13, `triage.ts`).
 */

import { feedbackKey } from '@forge/contracts/feedback';
import { FEEDBACK_MACHINE } from '@forge/contracts/feedback-machine';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { feedback, feedbackDecisions } from '../db/schema-feedback.js';
import type { Refusal } from '../lib/refusal.js';
import { movedRow, transition } from '../lifecycle/index.js';
import { emitEvent } from '../outbox/index.js';
import { forgeRefusal } from './forge-intake.js';
import { phaseOfRow } from './list-read.js';
import { type FeedbackActor, type Row, rowIn } from './read.js';
import { replyRefusal, type StandingReply } from './reply-rules.js';
import { decide, feedbackKernelActor, inTx, lockFeedback } from './service.js';

/** The reopen or reply a reopened item stands on: its latest; none while it reads anything else. */
export async function standingReplyOf(tx: Tx, row: Row): Promise<StandingReply | null> {
  if (row.status !== 'reopened') return null;
  const [d] = await tx
    .select({
      id: feedbackDecisions.id,
      decision: feedbackDecisions.decision,
      reason: feedbackDecisions.reason,
      at: feedbackDecisions.decidedAt,
    })
    .from(feedbackDecisions)
    .where(
      and(
        eq(feedbackDecisions.feedbackId, row.id),
        inArray(feedbackDecisions.decision, ['reopened', 'replied']),
      ),
    )
    .orderBy(desc(feedbackDecisions.decidedAt), desc(feedbackDecisions.id))
    .limit(1);
  if (!d) throw new Error(`feedback ${row.id} reads reopened with no reopen or reply decision`);
  return {
    id: d.id,
    decision: d.decision === 'replied' ? 'replied' : 'reopened',
    said: d.reason,
    at: d.at,
  };
}

/** The reporter of an item about Forge replies to its answer, with what the answer leaves open. */
export async function replyOwnForgeFeedback(input: {
  homeId: string;
  feedbackId: string;
  actor: FeedbackActor;
  evidence: string | undefined;
}): Promise<Refusal[] | null> {
  const { homeId, actor } = input;
  return inTx(async (tx) => {
    await lockFeedback(tx, homeId);
    const row = await rowIn(tx, homeId, input.feedbackId, true);
    const key = feedbackKey(row.fbSeq);
    if (row.reportedBy !== actor.userId) {
      return [
        forgeRefusal(
          'FORGE_FEEDBACK_NOT_YOURS',
          '/feedback',
          `${key} was filed by another account; only its reporter replies to its answer here.`,
        ),
      ];
    }
    const refused = replyRefusal(
      key,
      { status: row.status, route: row.route, phase: await phaseOfRow(homeId, row) },
      await standingReplyOf(tx, row),
      input.evidence,
    );
    if (refused) return [refused];
    const evidence = (input.evidence ?? '').trim();
    const moved = await transition(tx, FEEDBACK_MACHINE, {
      to: 'reopened',
      expect: row.status,
      set: { resolvedSeenAt: null, updatedAt: new Date() },
      where: eq(feedback.id, row.id),
      reason: evidence,
      actor: feedbackKernelActor(actor),
      source: 'feedback',
      returning: ['id'],
    });
    movedRow(moved);
    await decide(tx, row, actor, { decision: 'replied', reason: evidence });
    await emitEvent(tx, 'feedback.verifySettled', {
      projectId: row.projectId,
      feedbackId: row.id,
      key,
      decision: 'replied',
    });
    return null;
  });
}
