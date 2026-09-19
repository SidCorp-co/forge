export interface AdminGlanceMetric {
  value: number | null;
  deltaPct: number | null;
  spark: number[];
}

export const GLANCE_METRIC_NAMES = [
  'leadTimeMinutes',
  'interventionsPerClosed',
  'costPerClosedUsd',
  'successRatePct',
  'signupsWindow',
] as const;

export type AdminGlanceMetricName = (typeof GLANCE_METRIC_NAMES)[number];

export const GLANCE_WINDOWS = ['24h', '7d', '30d'] as const;

export type AdminMetricWindow = (typeof GLANCE_WINDOWS)[number];

export interface AdminMetricSeriesPoint {
  bucketStart: string;
  value: number | null;
}

export interface AdminMetricSeries {
  metric: AdminGlanceMetricName;
  window: AdminMetricWindow;
  value: number | null;
  deltaPct: number | null;
  points: AdminMetricSeriesPoint[];
}

/** `GET /api/admin/overview?window=24h|7d|30d`. */
export interface AdminOverview {
  counts: {
    users: number;
    usersNew: number;
    orgs: number;
    projects: number;
    activeWorkspaces: number;
    devicesOnline: number;
    devicesTotal: number;
  };
  kpis: {
    openAlerts: number;
    inFlightJobs: number;
    spendWindowUsd: number;
    spendBaselineUsd: number;
  };
  glance: Record<AdminGlanceMetricName, AdminGlanceMetric>;
}

/** One bucket of `GET /api/admin/adoption?weeks=&bucket=`. The series is dense:
 *  a bucket with no rows is present at zero. */
export interface AdminAdoptionBucket {
  bucketStart: string;
  newUsers: number;
  cumulativeUsers: number;
  activeWorkspaces: number;
}

/** One row of `GET /api/admin/workspaces?window=&sort=&limit=`. */
export interface AdminWorkspaceRow {
  projectId: string;
  slug: string;
  runs: number;
  spendUsd: number;
  medianLeadTimeMin: number | null;
  openIssues: number;
}

export type AdminAlertId = 'A1' | 'A2' | 'A3' | 'A4' | 'A5';
export type AdminAlertStatus = 'ok' | 'warn' | 'crit';

/** One contributor to an alert. `ref` is the id of the row named by `kind`, so
 *  an A2 entity's `ref` is the job id the reap action cancels. */
export interface AdminAlertEntity {
  ref: string;
  kind: 'job' | 'project' | 'runner' | 'schedule' | 'integration_binding';
  label: string;
}

/** One of the five Tier 1 alerts, from `GET /api/admin/alerts`. */
export interface AdminAlert {
  id: AdminAlertId;
  key: string;
  status: AdminAlertStatus;
  /** True total, NOT entities.length — entities is capped at ENTITY_LIMIT. */
  count: number;
  detail: string;
  /** ISO of the oldest contributing entity; null when status is 'ok'. */
  since: string | null;
  entities: AdminAlertEntity[];
}

/**
 * ISS-654 — the Tier 1 thresholds and the spend ceiling, as operator policy.
 *
 * `spendCeilingUsdDay` is null when no ceiling is set; every other field is
 * always present, so a reader never branches on absence.
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

export const SENTRY_THRESHOLD_MIN = 1;
export const SENTRY_THRESHOLD_MAX = 1_000_000;

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
