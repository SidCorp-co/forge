/**
 * ISS-652 — the push half of the Tier 1 alert engine. Runs as one pass inside
 * `pipeline/sweeper.ts`'s `runPipelineSweep`, computing the same 5 alerts the
 * GET route serves (`alert-queries.ts` is the shared source) and writing
 * `notifications` rows when one crosses into warn/crit.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { resolveNotifications } from '../notifications/auto-resolve.js';
import { deliverExisting } from '../notifications/deliver.js';
import { emissionAllowed, noteSuppressed } from '../notifications/emission-switch.js';
import { platformAdminUserIds } from '../notifications/platform-admins.js';
import { computeAlerts, opsAlertResolutionKey } from './alert-queries.js';
import type { AdminAlert } from './types.js';

export interface AlertSweepResult {
  evaluated: number;
  notified: number;
  resolved: number;
}

// cm:why an in-process gate resets on restart, so re-running one extra sweep right after a deploy is harmless — dedup is DB-backed (the active-row claim below), not this gate
const ALERT_SWEEP_INTERVAL_MS = (() => {
  const env = Number(process.env.FORGE_ALERT_SWEEP_INTERVAL_MS);
  return Number.isFinite(env) && env > 0 ? env : 5 * 60_000;
})();

let lastSweepAt = 0;

const ALERT_TITLES: Record<AdminAlert['id'], string> = {
  A1: 'Orphan jobs detected',
  A2: 'Stuck jobs detected',
  A3: 'Runner starvation detected',
  A4: 'Spend spike detected',
  A5: 'Automation failing',
};

/**
 * Atomically claim (or escalate) the ops-alert RECORD for this key. Backed by the
 * `notifications_ops_alert_active_uq` partial unique index (one active `ops_alert` record
 * per `resolution_key`), so this is safe under concurrent sweepers (multiple core
 * replicas) — unlike a check-then-insert.
 *
 * - No active record yet for this key → `INSERT ... ON CONFLICT DO NOTHING` claims it; a
 *   losing race just no-ops (the winner already claimed it).
 * - An active record exists → its title and body are refreshed in place on every sweep
 *   (the unique index means there is never a second row to reconcile), and it counts as an
 *   ESCALATION only when the severity moved, e.g. warn -> crit.
 *
 * ISS-1063 — this is per KEY, not per admin, and that is the change. It used to be called
 * once per admin and the index was on `(user_id, resolution_key)`: with one record and many
 * deliveries, the second admin's call now hits the first admin's row, finds no severity
 * move, and would be told nothing at all. Who is told is the caller's business, one
 * `deliverExisting` for every admin at once.
 */
// cm:why escalation updates the active record instead of resolving then re-emitting — the active-record index preserves one incident per key until the condition itself clears
async function claimOrEscalate(input: {
  title: string;
  body: string;
  severity: 'warning' | 'error';
  resolutionKey: string;
}): Promise<{ id: string; escalated: boolean } | null> {
  const { title, body, severity, resolutionKey } = input;

  // cm:guard ISS-1063 — this INSERT bypasses `createNotification`, so it consults the
  // emission switch here. It is NOT routed through that function: the `ON CONFLICT`
  // against `notifications_ops_alert_active_uq` is what makes the claim atomic across
  // replicas, and a helper that selects then inserts would put the check-then-insert
  // race back. `ops_alert` is the one type the switch exempts, so today this returns
  // true every time; the guard exists so that a future decision to silence ops alerts
  // has one place to be made rather than two.
  // cm:edge lockstep -> packages/core/src/notifications/emission-switch.ts — one of the two producers that write `notifications` directly; the other is pm/auto-disable.ts
  if (!emissionAllowed('ops_alert')) {
    noteSuppressed('ops_alert', title);
    return null;
  }

  // cm:guard ISS-1063 — the conflict target lost `user_id` because the record lost it: one
  // active ops_alert per resolution key, and the admins get a delivery each. The predicate
  // must still match `notifications_ops_alert_active_uq` verbatim or this INSERT throws.
  const claimed = await db.execute<{ id: string }>(sql`
    INSERT INTO notifications (project_id, type, kind, tier, state, title, body, severity, resolution_key, pending_since, last_seen_at, created_at)
    VALUES (NULL, 'ops_alert', 'condition', 'ticket', 'firing', ${title}, ${body}, ${severity}, ${resolutionKey}, now(), now(), now())
    ON CONFLICT (resolution_key) WHERE resolved_at IS NULL AND resolution_key IS NOT NULL AND type = 'ops_alert' DO NOTHING
    RETURNING id
  `);
  if (claimed[0]?.id) return { id: claimed[0].id, escalated: false };

  {
    // cm:guard the CTE must be `FOR UPDATE`, not a plain `FROM notifications prev` self-join — a non-locked rowmark is re-read under EvalPlanQual, so with two core replicas sweeping at once BOTH read the pre-update severity, both report an escalation, and the recipient is notified twice for one move. Locking the row first serializes them: the loser sees the winner's severity and refreshes the text silently.
    // cm:guard refresh title/body on EVERY sweep, notify only on a severity move — gating the whole UPDATE on the severity change froze the text for the life of the incident, so an A2 opened at 3 stuck jobs still read "3 jobs" at 30, with no second notification coming to correct it. Reading `prev` is the only way to have both: RETURNING yields the NEW row, so the pre-update severity is otherwise unreachable.
    // cm:guard ISS-1063 — the read-clearing arm moved OUT of this statement and onto the
    // deliveries in the caller, for the reason it existed: an escalation on a row an admin
    // had already opened must reach a channel, and the channel that counts read state is
    // the delivery. Clearing it here is no longer possible because `read` is not on this
    // table, and the escalation-only condition is unchanged — clearing on every sweep would
    // re-mark it unread forever while the condition lasts.
    const updated = await db.execute<{ id: string; escalated: boolean }>(sql`
      WITH locked AS (
        SELECT id, severity FROM notifications
        WHERE resolution_key = ${resolutionKey}
          AND type = 'ops_alert' AND resolved_at IS NULL
        FOR UPDATE
      )
      UPDATE notifications n
      SET severity = ${severity}, title = ${title}, body = ${body}, last_seen_at = now()
      FROM locked prev
      WHERE prev.id = n.id
      RETURNING n.id, (prev.severity IS DISTINCT FROM ${severity}) AS escalated
    `);
    if (!updated[0]) return null;
    return { id: updated[0].id, escalated: updated[0].escalated };
  }
}

/** Un-read every admin's delivery of this record — an escalation has to reach a surface. */
async function unreadDeliveries(notificationId: string): Promise<void> {
  // cm:guard ISS-1063 — an escalation un-reads the admin's DELIVERY, and only on a
  // severity move. Without it the escalation reaches no surface at all: the toast needs a
  // live socket and the bell counts unread deliveries, and the row keeps its original
  // created_at so it does not resurface on its own.
  await db.execute(sql`
    UPDATE notification_deliveries d SET read_at = NULL
    FROM notification_delivery_members m
    WHERE m.delivery_id = d.id AND m.notification_id = ${notificationId}
  `);
}

/** Never throws — same contract as `detectStrandedIssues`. */
export async function runAlertSweep(now: Date = new Date()): Promise<AlertSweepResult> {
  if (now.getTime() - lastSweepAt < ALERT_SWEEP_INTERVAL_MS) {
    return { evaluated: 0, notified: 0, resolved: 0 };
  }
  lastSweepAt = now.getTime();

  try {
    const alerts = await computeAlerts({ now });
    const adminIds = await platformAdminUserIds();
    let notified = 0;
    let resolved = 0;

    for (const alert of alerts) {
      const resolutionKey = opsAlertResolutionKey(alert.id);

      if (alert.status === 'ok') {
        // cm:edge lockstep -> packages/core/src/notifications/auto-resolve.ts — this pass depends on resolveNotifications stamping READ-but-active rows too; an acknowledged ops_alert keeps resolved_at NULL, stays active under the partial unique index, and would block every later recurrence from re-firing
        resolved += await resolveNotifications(resolutionKey);
        continue;
      }

      const severity = alert.status === 'crit' ? 'error' : 'warning';
      const title = `${ALERT_TITLES[alert.id]} — ${alert.detail}`;

      const record = await claimOrEscalate({
        title,
        body: alert.detail,
        severity,
        resolutionKey,
      });
      if (!record) continue;

      // cm:why the `notificationCreated` hook is NOT emitted here (ISS-1063): it is emitted
      // once per delivery inside `deliverExisting`, with the same payload the WS bridge
      // reads. Emitting it here as well would fan one escalation out twice.
      if (record.escalated) {
        await unreadDeliveries(record.id);
        notified += adminIds.length;
      } else {
        notified += await deliverExisting(record.id, adminIds);
      }
    }

    return { evaluated: alerts.length, notified, resolved };
  } catch (err) {
    logger.error({ err }, 'alert-sweeper: sweep failed');
    return { evaluated: 0, notified: 0, resolved: 0 };
  }
}
