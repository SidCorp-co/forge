/**
 * The push half of the Tier 1 alert engine: a cluster timer every five minutes
 * (`timer-registry.ts`), computing the same 5 alerts the GET route serves
 * (`alert-queries.ts` is the shared source) and writing `notifications` rows
 * when one crosses into warn/crit.
 */

import { resolveNotifications } from '../notifications/auto-resolve.js';
import { deliverExisting } from '../notifications/deliver.js';
import { claimOpsAlert, unreadAlertDeliveries } from '../notifications/ops-alerts.js';
import { platformAdminUserIds } from '../notifications/platform-admins.js';
import { logger } from '../observability/logger.js';
import { computeAlerts, opsAlertResolutionKey } from './alert-queries.js';
import type { AdminAlert } from './types.js';

export interface AlertSweepResult {
  evaluated: number;
  notified: number;
  resolved: number;
}

const ALERT_TITLES: Record<AdminAlert['id'], string> = {
  A1: 'Orphan jobs detected',
  A2: 'Stuck jobs detected',
  A3: 'Runner starvation detected',
  A4: 'Spend spike detected',
  A5: 'Automation failing',
};

/** Never throws — same contract as `detectStrandedIssues`. */
export async function runAlertSweep(now: Date = new Date()): Promise<AlertSweepResult> {
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

      const record = await claimOpsAlert({
        title,
        body: alert.detail,
        severity,
        resolutionKey,
      });
      if (!record) continue;

      if (record.escalated) {
        await unreadAlertDeliveries(record.id);
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
