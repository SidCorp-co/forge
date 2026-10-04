/**
 * ISS-654 — the Tier 1 thresholds and the spend ceiling. `spendCeilingUsdDay` is null when no
 * ceiling is set; every other field is always present, so a reader never branches on absence.
 */
export interface AdminThresholds {
  stuckJobSeconds: number;
  runnerStarvedSeconds: number;
  spendCeilingUsdDay: number | null;
  spendSpikeMultiple: number;
  scheduleFailStreak: number;
  deliveryFailRatePct: number;
  interventionLabels: string[];
  ghostRunnerOfflineDays: number;
  sentryMinEventCount: number;
  sentryMinUserCount: number;
}

export const ADMIN_THRESHOLD_DEFAULTS: AdminThresholds = {
  stuckJobSeconds: 600,
  runnerStarvedSeconds: 300,
  spendCeilingUsdDay: null,
  spendSpikeMultiple: 2.5,
  scheduleFailStreak: 2,
  deliveryFailRatePct: 20,
  interventionLabels: ['kernel-hardening', 'onboarding'],
  ghostRunnerOfflineDays: 14,
  sentryMinEventCount: 10,
  sentryMinUserCount: 2,
};

export async function readThresholds(): Promise<AdminThresholds> {
  return ADMIN_THRESHOLD_DEFAULTS;
}
