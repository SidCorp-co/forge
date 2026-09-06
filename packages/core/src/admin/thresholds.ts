/**
 * ISS-654 — the one reader of `admin_thresholds`.
 *
 * Every Tier 1 threshold and the spend ceiling used to be a module constant in
 * `alert-queries.ts` with an optional `FORGE_ALERT_*` override, so changing one
 * meant a redeploy. They are now operator policy, read here and threaded into
 * `computeAlerts`, the ghost-runner reaper and the intervention-label lanes.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { ADMIN_THRESHOLDS_ID, adminThresholds } from '../db/schema-admin-thresholds.js';
import { ADMIN_THRESHOLD_DEFAULTS, type AdminThresholds } from './types.js';

// cm:why deliberately NOT cached in-process. The sweeper reads once per 5-minute tick and the GET routes read once per request, so this is a primary-key lookup on a one-row table; a TTL cache would buy nothing measurable and would make "the sweeper reads the config dynamically" (ISS-654 AC 1) true only after an interval nobody can see.
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
  };
}
