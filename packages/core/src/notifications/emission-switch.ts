/**
 * ISS-1063 — the emission switch: the one seam where a notification type can be
 * turned off, and the record of the silence it carried.
 *
 * WHAT IT IS NOW. {@link SUPPRESSED_TYPES} is EMPTY, so this module suppresses
 * nothing: every declared type emits. What survives is the mechanism — one
 * checked seam, three callers, and a test holding them as a closed inventory —
 * so that turning a type off is a one-line diff somebody can read, rather than
 * nine emitters edited by hand.
 *
 * WHAT IT CARRIED, AND WHY THAT IS WRITTEN DOWN RATHER THAN DELETED. Between
 * the two landings of ISS-1063 this set held every type but `ops_alert`, and
 * for that window Forge told nobody anything else: no bell row, no toast, no
 * row in the table a later reader could count, and nothing queued to be said
 * afterwards. A gap in the notification history between 2026-09-16 21:48Z and
 * the deploy of the record-kind model is that silence and not a data loss.
 *
 * WHAT IT COST AND WHY IT WAS PAID. Measured on the beta replica 2026-09-16:
 * 11037 rows over 14 users; the owner's own account held 7441 of them and read
 * 36 unread against 5663 unresolved. 3333 of his 5663 open rows were
 * `issue_status_changed`, a type that cannot resolve by its nature, and 2023
 * were `pipeline_wedge`, a condition with no re-evaluation loop. 69% of the
 * pile was unactionable and it buried the 24 `ops_alert` rows that are each an
 * agent standing still. The owner's instruction, recorded on ISS-1063 at
 * 2026-09-16 15:55:28Z: the current notifications are spam, and losing them
 * entirely for a while costs less than continuing to read them.
 *
 * THE CONDITION THAT ENDED IT, MET. The three-record-kind model — signal,
 * condition and task, with a count over what is still true rather than over
 * what has been looked at — is what this file shipped beside. The set emptied
 * in the same change that landed it.
 *
 * THE CARVE-OUT, KEPT AS A DECISION EVEN THOUGH THE SET IS EMPTY. `ops_alert`
 * was never suppressed, and it is still not louder than it was: it is recorded
 * at the `ticket` tier in `notifications/kinds.ts`, not `page`. The owner was
 * offered a third option — keep it on AND raise it to a page tier while the
 * rest was silent — and did not take it.
 *
 * A PER-READER silence, bounded and expiring, is a different mechanism and
 * lives in `notification_silences` (`notifications/silences-routes.ts`). This
 * switch is the operator's blunt one: deployment-wide, in code, visible in a
 * diff.
 */
import type { NotificationType } from '../db/schema.js';
import { logger } from '../logger.js';

/**
 * The types this deployment does not emit. EMPTY — see the header.
 *
 * This is a code constant and not configuration on purpose: an amnesty whose
 * extent is read from a database is an amnesty nobody can see in the diff that
 * ends it. That property is why the set is still here now that it is empty —
 * the next operator who needs a type off adds one line, and the reviewer of
 * that line sees exactly what goes quiet.
 */
export const SUPPRESSED_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([]);

/**
 * Whether a notification of this type may be written at all.
 *
 * Three callers, and there are three because three places write the table:
 * - `notifications/routes.ts:createNotification` — the funnel every emitter
 *   that can use it goes through;
 * - `admin/alert-sweeper.ts:claimOrEscalate` — writes `INSERT ... ON CONFLICT`
 *   directly, because that conflict clause against
 *   `notifications_ops_alert_active_uq` is what makes the claim atomic across
 *   core replicas; a select-then-insert helper would put the race back;
 * - `pm/auto-disable.ts` — writes with the caller's `tx`, because the row and
 *   the cadence disable must land together or neither, and `createNotification`
 *   uses the module-level `db`.
 *
 * A fourth writer is refused by `emission-switch.test.ts`, which holds the
 * three above as a closed inventory.
 */
export function emissionAllowed(type: NotificationType): boolean {
  return !SUPPRESSED_TYPES.has(type);
}

/**
 * The refusal, logged rather than silent.
 *
 * A suppressed emission is a thing that happened and was not told to anybody,
 * so the log line is the only record it existed. It stays `info`: with the set
 * empty this line cannot be reached at all, and the operator who puts a type
 * back into the set is choosing a flood of these over a flood of bells.
 */
export function noteSuppressed(type: NotificationType, title: string): void {
  logger.info(
    { type, title, reason: 'ISS-1063 emission switch' },
    'notifications: suppressed by the emission switch — nobody is told, now or later',
  );
}
