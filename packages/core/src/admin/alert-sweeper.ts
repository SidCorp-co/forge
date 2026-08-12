/**
 * ISS-652 — the push half of the Tier 1 alert engine. Runs as one pass inside
 * `pipeline/sweeper.ts`'s `runPipelineSweep`, computing the same 5 alerts the
 * GET route serves (`alert-queries.ts` is the shared source) and writing
 * `notifications` rows when one crosses into warn/crit.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications } from '../db/schema.js';
import { logger } from '../logger.js';
import { resolveNotifications } from '../notifications/auto-resolve.js';
import { emitNotification } from '../notifications/emit.js';
import { platformAdminUserIds } from '../notifications/platform-admins.js';
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

/** Never throws — same contract as `detectStrandedIssues`. */
export async function runAlertSweep(now: Date = new Date()): Promise<AlertSweepResult> {
  if (now.getTime() - lastSweepAt < ALERT_SWEEP_INTERVAL_MS) {
    return { evaluated: 0, notified: 0, resolved: 0 };
  }
  lastSweepAt = now.getTime();

  try {
    const alerts = await computeAlerts({ now });
    let notified = 0;
    let resolved = 0;

    for (const alert of alerts) {
      const resolutionKey = opsAlertResolutionKey(alert.id);

      if (alert.status === 'ok') {
        resolved += await resolveNotifications(resolutionKey);
        continue;
      }

      const severity = alert.status === 'crit' ? 'error' : 'warning';
      const [existing] = await db
        .select({ id: notifications.id, severity: notifications.severity })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, 'ops_alert'),
            eq(notifications.read, false),
            eq(notifications.resolutionKey, resolutionKey),
          ),
        )
        .limit(1);

      if (existing && existing.severity === severity) continue;
      if (existing) resolved += await resolveNotifications(resolutionKey);

      const adminIds = await platformAdminUserIds();
      for (const userId of adminIds) {
        await emitNotification({
          userId,
          projectId: null,
          type: 'ops_alert',
          title: `${ALERT_TITLES[alert.id]} — ${alert.detail}`,
          body: alert.detail,
          severity,
          resolutionKey,
        });
        notified++;
      }
    }

    return { evaluated: alerts.length, notified, resolved };
  } catch (err) {
    logger.error({ err }, 'alert-sweeper: sweep failed');
    return { evaluated: 0, notified: 0, resolved: 0 };
  }
}
