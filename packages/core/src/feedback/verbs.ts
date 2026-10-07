/**
 * Two of the four triage verbs that are not a route: accept (new or reopened to triaged, no route
 * written, optionally about a requirement) and snooze (parked out of New until a date, with the reason
 * its triager reads on return). Decline and duplicate are routes of `triage.ts`. Each is one
 * transition or one write under the feedback lock, refused by name where it does not apply.
 */

import { FEEDBACK_LIMITS } from '@forge/contracts/feedback';
import { FEEDBACK_MACHINE } from '@forge/contracts/feedback-machine';
import { eq } from 'drizzle-orm';
import { feedback, feedbackRouteIssues } from '../db/schema-feedback.js';
import { dataPolicyOf, storedText } from '../lib/data-egress.js';
import { movedRow, transition } from '../lifecycle/index.js';
import { phaseOfRow } from './list-read.js';
import type { FeedbackActor } from './read.js';
import { isRefusal, requirementRefIn } from './refs.js';
import { retargetIn } from './retarget.js';
import { NO_ROUTE } from './route-write.js';
import {
  closeClarification,
  decide,
  type FeedbackOutcome,
  feedbackKernelActor,
  NOT_SNOOZED,
} from './service.js';
import { approvedActOn } from './triage.js';
import { acceptRefusal, snoozeRefusal } from './verb-rules.js';

/** Accept: the item is triaged with no route yet, so it is the triager's to route to work. */
export function acceptFeedback(input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
  requirement?: string | undefined;
}): Promise<FeedbackOutcome> {
  const { projectId, actor } = input;
  return approvedActOn(input, 'accepting feedback', async (tx, row) => {
    const refused = acceptRefusal(await phaseOfRow(projectId, row));
    if (refused) return { refusals: [refused] };
    if (input.requirement) {
      const req = await requirementRefIn(projectId, input.requirement, '/requirement');
      if (isRefusal(req)) return { refusals: [req] };
      if (row.requirementId !== req.id) {
        const moved = await retargetIn(tx, row, actor, {
          requirement: req.key,
          reason: 'accepted as about this requirement',
        });
        if (moved) return { refusals: moved };
      }
    }
    await tx
      .update(feedback)
      .set({
        route: null,
        ...NO_ROUTE,
        ...NOT_SNOOZED,
        resolvedSeenAt: null,
        updatedAt: new Date(),
      })
      .where(eq(feedback.id, row.id));
    await tx.delete(feedbackRouteIssues).where(eq(feedbackRouteIssues.feedbackId, row.id));
    const moved = await transition(tx, FEEDBACK_MACHINE, {
      to: 'triaged',
      expect: row.status,
      where: eq(feedback.id, row.id),
      actor: feedbackKernelActor(actor),
      source: 'feedback-accept',
      returning: ['id'],
    });
    movedRow(moved);
    await decide(tx, row, actor, { decision: 'accepted' });
    await closeClarification(tx, row.id, 'accepted');
    return { refusals: null };
  });
}

/** Snooze: out of New until `until`, back on its own then (the read model, not a timer, returns it). */
export function snoozeFeedback(input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
  until: Date;
  reason: string | undefined;
  now?: Date;
}): Promise<FeedbackOutcome> {
  const { projectId, actor } = input;
  return approvedActOn(input, 'snoozing feedback', async (tx, row) => {
    const refused = snoozeRefusal(
      await phaseOfRow(projectId, row),
      input.until,
      input.reason,
      input.now ?? new Date(),
      FEEDBACK_LIMITS.snoozeDays,
    );
    if (refused) return { refusals: [refused] };
    const reason = storedText(await dataPolicyOf(projectId), (input.reason ?? '').trim()).text;
    await tx
      .update(feedback)
      .set({ snoozedUntil: input.until, snoozeReason: reason, updatedAt: new Date() })
      .where(eq(feedback.id, row.id));
    await decide(tx, row, actor, {
      decision: 'snoozed',
      reason: `Until ${input.until.toISOString().slice(0, 10)}: ${reason}`,
    });
    return { refusals: null };
  });
}
