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

async function claimOrEscalate(input: {
  title: string;
  body: string;
  severity: 'warning' | 'error';
  resolutionKey: string;
}): Promise<{ id: string; escalated: boolean } | null> {
  const { title, body, severity, resolutionKey } = input;

  if (!emissionAllowed('ops_alert')) {
    noteSuppressed('ops_alert', title);
    return null;
  }

  const claimed = await db.execute<{ id: string }>(sql`
    INSERT INTO notifications (project_id, type, kind, tier, state, title, body, severity, resolution_key, pending_since, last_seen_at, created_at)
    VALUES (NULL, 'ops_alert', 'condition', 'ticket', 'firing', ${title}, ${body}, ${severity}, ${resolutionKey}, now(), now(), now())
    ON CONFLICT (resolution_key) WHERE resolved_at IS NULL AND resolution_key IS NOT NULL AND type = 'ops_alert' DO NOTHING
    RETURNING id
  `);
  if (claimed[0]?.id) return { id: claimed[0].id, escalated: false };

  {
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
