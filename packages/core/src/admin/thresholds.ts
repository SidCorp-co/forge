import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { ADMIN_THRESHOLDS_ID, adminThresholds } from '../db/schema-admin-thresholds.js';
import { ADMIN_THRESHOLD_DEFAULTS, type AdminThresholds } from './types.js';

export async function readThresholds(): Promise<AdminThresholds> {
  const [row] = await db
    .select()
    .from(adminThresholds)
    .where(eq(adminThresholds.id, ADMIN_THRESHOLDS_ID))
    .limit(1);
  if (!row) return ADMIN_THRESHOLD_DEFAULTS;
  return {
    stuckJobSeconds: row.stuckJobSeconds,
    runnerStarvedSeconds: row.runnerStarvedSeconds,
    spendCeilingUsdDay: row.spendCeilingUsdDay,
    spendSpikeMultiple: row.spendSpikeMultiple,
    scheduleFailStreak: row.scheduleFailStreak,
    deliveryFailRatePct: row.deliveryFailRatePct,
    interventionLabels: row.interventionLabels,
    ghostRunnerOfflineDays: row.ghostRunnerOfflineDays,
    sentryMinEventCount: row.sentryMinEventCount,
    sentryMinUserCount: row.sentryMinUserCount,
  };
}
