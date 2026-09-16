/**
 * ISS-1063 — the priced silence, and the mechanism that outlives it.
 *
 * WHAT IS TRADED. While a type is suppressed here, Forge tells nobody anything
 * about it. No bell row, no toast, no browser notification, no row in the
 * table a later reader could count. A condition that becomes true during the
 * silence is never announced, and it is not queued for announcement later.
 *
 * WHAT THAT COSTS, AND WHY IT WAS PAID. Measured on the beta replica
 * 2026-09-16: 11037 notification rows over 14 users; the owner's own account
 * holds 7441 of them and reads 36 unread against 5663 unresolved. 3333 of his
 * 5663 open rows are `issue_status_changed`, a type that cannot resolve by its
 * nature, and 2023 are `pipeline_wedge`, a condition with no re-evaluation
 * loop. 69% of the pile is unactionable and it buries the 24 `ops_alert` rows
 * that are each an agent standing still. The owner's instruction, recorded on
 * ISS-1063 at 2026-09-16 15:55:28Z: the current notifications are spam, and
 * losing them entirely for a while costs less than continuing to read them.
 *
 * THE CONDITION THAT ENDS IT. The three-record-kind model shipping — signal,
 * condition and task, with a count over what is still true rather than over
 * what has been looked at. When that lands, {@link SUPPRESSED_TYPES} empties
 * and this module keeps only its second job.
 *
 * THE CARVE-OUT, AND IT IS THE ONLY ONE. `ops_alert` keeps emitting, exactly
 * as loud as it is today. At 92% resolve it is the one surface reporting that
 * an agent asked a question no channel can deliver; silencing it would hide
 * the only work this system currently does correctly rather than reduce noise.
 * The owner was offered a third option — keep it on AND raise it to a page
 * tier while the rest is silent — and did not take it, so nothing here makes
 * it louder either.
 */

import type { NotificationType } from '../db/schema.js';
import { logger } from '../logger.js';

/**
 * The types this deployment does not emit.
 *
 * This is a code constant and not configuration on purpose: an amnesty whose
 * extent is read from a database is an amnesty nobody can see in the diff that
 * ends it.
 */
// cm:hack ISS-1063 until:the record/kind model ships and the open count is over conditions and tasks rather than over unread rows — every type but `ops_alert` is suppressed at the single emission seam, which is the priced trade the header states
export const SUPPRESSED_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
  'issue_status_changed',
  'comment_added',
  'agent_completed',
  'mention',
  'pm_escalation',
  'pipeline_wedge',
  'invitation_received',
  'intake_pending',
  'schedule_report',
  'reconcile_gate_pending',
  'issue_stranded',
  'retry_rescue_threshold',
]);

/**
 * Whether a notification of this type may be written at all.
 *
 * Called from `createNotification` and from nowhere else, so that every
 * producer obeys it: the two that used to write the table directly
 * (`admin/alert-sweeper.ts`, `pm/auto-disable.ts`) route through that function
 * as of this change precisely so neither can escape this gate.
 */
export function emissionAllowed(type: NotificationType): boolean {
  return !SUPPRESSED_TYPES.has(type);
}

/**
 * The refusal, logged rather than silent.
 *
 * A suppressed emission is a thing that happened and was not told to anybody,
 * so the log line is the only record it existed. It is `info` because during
 * the silence this is the expected path for twelve of thirteen types and a
 * warning per suppressed notification would be the same flood one layer down.
 */
export function noteSuppressed(type: NotificationType, title: string): void {
  logger.info(
    { type, title, reason: 'ISS-1063 emission switch' },
    'notifications: suppressed — the old surface is off until the record-kind model ships',
  );
}
