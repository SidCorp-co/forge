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

// cm:why an in-process gate resets on restart, so re-running one extra sweep right after a deploy is harmless — dedup is DB-backed (the unread-row check below), not this gate
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
 * `notifications_user_resolution_key_unread_uq` partial unique index (one
 * unread `ops_alert` row per `(user_id, resolution_key)`), so this is safe
 * under concurrent sweepers (multiple core replicas) — unlike a
 * check-then-insert.
 *
 * - No unread row yet for this admin+key → `INSERT ... ON CONFLICT DO NOTHING`
 *   claims it; a losing race just no-ops (the winner already claimed it).
 * - An unread row already exists at a different severity (escalation, e.g.
 *   warn -> crit) → updated in place; the unique index means there is never a
 *   second row to reconcile.
 * - An unread row exists at the same severity → no-op.
 */
// cm:why escalation updates in place instead of the plan's resolve-then-re-emit — the unique index allows only one unread row per (user, key), and a resolved-then-recreated pair would report the live condition as both cleared and open
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
    ON CONFLICT (user_id, resolution_key) WHERE read = false AND resolution_key IS NOT NULL AND type = 'ops_alert' DO NOTHING
    RETURNING id
  `);
  let notificationId = claimed[0]?.id;

  if (!notificationId) {
    const escalated = await db.execute<{ id: string }>(sql`
      UPDATE notifications
      SET severity = ${severity}, title = ${title}, body = ${body}
      WHERE user_id = ${userId} AND resolution_key = ${resolutionKey}
        AND type = 'ops_alert' AND read = false AND severity IS DISTINCT FROM ${severity}
      RETURNING id
    `);
    notificationId = escalated[0]?.id;
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
