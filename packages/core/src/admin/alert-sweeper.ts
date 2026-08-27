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
import { platformAdminUserIds } from '../notifications/platform-admins.js';
import { hooks } from '../pipeline/hooks.js';
import { type AdminAlert, computeAlerts, opsAlertResolutionKey } from './alert-queries.js';

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
 * Atomically claim (or escalate) this admin's ops-alert row. Backed by the
 * `notifications_ops_alert_active_uq` partial unique index
 * (one active `ops_alert` row per `(user_id, resolution_key)`), so this is safe
 * under concurrent sweepers (multiple core replicas) — unlike a
 * check-then-insert.
 *
 * - No active row yet for this admin+key → `INSERT ... ON CONFLICT DO NOTHING`
 *   claims it; a losing race just no-ops (the winner already claimed it).
 * - An active row already exists → its title and body are refreshed in place on
 *   every sweep (the unique index means there is never a second row to
 *   reconcile), but the recipient is re-notified ONLY when the severity moved,
 *   e.g. warn -> crit.
 *
 * Returns whether the recipient was notified, NOT whether a row was written.
 */
// cm:why escalation updates the active row instead of resolving then re-emitting — the active-row index preserves one incident per recipient/key until the condition itself clears
async function claimOrEscalate(input: {
  userId: string;
  title: string;
  body: string;
  severity: 'warning' | 'error';
  resolutionKey: string;
}): Promise<boolean> {
  const { userId, title, body, severity, resolutionKey } = input;

  const claimed = await db.execute<{ id: string }>(sql`
    INSERT INTO notifications (user_id, project_id, type, title, body, severity, resolution_key, read, created_at)
    VALUES (${userId}, NULL, 'ops_alert', ${title}, ${body}, ${severity}, ${resolutionKey}, false, now())
    ON CONFLICT (user_id, resolution_key) WHERE resolved_at IS NULL AND resolution_key IS NOT NULL AND type = 'ops_alert' DO NOTHING
    RETURNING id
  `);
  let notificationId = claimed[0]?.id;

  if (!notificationId) {
    // cm:guard the CTE must be `FOR UPDATE`, not a plain `FROM notifications prev` self-join — a non-locked rowmark is re-read under EvalPlanQual, so with two core replicas sweeping at once BOTH read the pre-update severity, both report an escalation, and the recipient is notified twice for one move. Locking the row first serializes them: the loser sees the winner's severity and refreshes the text silently.
    // cm:guard refresh title/body on EVERY sweep, notify only on a severity move — gating the whole UPDATE on the severity change froze the text for the life of the incident, so an A2 opened at 3 stuck jobs still read "3 jobs" at 30, with no second notification coming to correct it. Reading `prev` is the only way to have both: RETURNING yields the NEW row, so the pre-update severity is otherwise unreachable.
    // cm:guard clear `read` on a severity move, and ONLY on a severity move — an escalation on a row the admin had already opened otherwise reaches no channel at all: the toast needs a live socket, the bell counts unread, and the row keeps its original created_at so it does not resurface. It never self-heals either, because the next sweep finds severity already 'error' and fires nothing. Clearing it on every sweep instead would re-mark the row unread forever while the condition lasts.
    const updated = await db.execute<{ id: string; escalated: boolean }>(sql`
      WITH locked AS (
        SELECT id, severity FROM notifications
        WHERE user_id = ${userId} AND resolution_key = ${resolutionKey}
          AND type = 'ops_alert' AND resolved_at IS NULL
        FOR UPDATE
      )
      UPDATE notifications n
      SET severity = ${severity}, title = ${title}, body = ${body},
          read = CASE WHEN prev.severity IS DISTINCT FROM ${severity} THEN false ELSE n.read END
      FROM locked prev
      WHERE prev.id = n.id
      RETURNING n.id, (prev.severity IS DISTINCT FROM ${severity}) AS escalated
    `);
    if (!updated[0]?.escalated) return false;
    notificationId = updated[0].id;
  }

  if (!notificationId) return false;

  await hooks.emit('notificationCreated', {
    notificationId,
    userId,
    projectId: null,
    type: 'ops_alert',
    title,
    body,
    severity,
    resolutionKey,
    issueId: null,
    secondaryIssueId: null,
    agentSessionId: null,
    decisionId: null,
  });
  return true;
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

      for (const userId of adminIds) {
        const changed = await claimOrEscalate({
          userId,
          title,
          body: alert.detail,
          severity,
          resolutionKey,
        });
        if (changed) notified++;
      }
    }

    return { evaluated: alerts.length, notified, resolved };
  } catch (err) {
    logger.error({ err }, 'alert-sweeper: sweep failed');
    return { evaluated: 0, notified: 0, resolved: 0 };
  }
}
