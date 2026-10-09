/**
 * Snooze, the triage act that is not a route (Feedback triage r16 `snooze`): parked out of New until
 * a date, with the reason its triager reads on return. Decline and duplicate are acts of `triage.ts`.
 * An item reaches triaged only through the triage checklist, so no act here moves it there.
 */

import { FEEDBACK_LIMITS } from '@forge/contracts/feedback';
import { eq } from 'drizzle-orm';
import { feedback } from '../db/schema-feedback.js';
import { dataPolicyOf, storedText } from '../lib/data-egress.js';
import { phaseOfRow } from './list-read.js';
import type { FeedbackActor } from './read.js';
import { decide, type FeedbackOutcome } from './service.js';
import { approvedActOn } from './triage.js';
import { snoozeRefusal } from './verb-rules.js';

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
