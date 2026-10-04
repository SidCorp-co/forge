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

export type AdminAlertId = 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6';
export type AdminAlertStatus = 'ok' | 'warn' | 'crit';

/** One contributor to an alert. `ref` is the id of the row named by `kind`, so
 *  an A2 entity's `ref` is the job id the reap action cancels. */
export interface AdminAlertEntity {
  ref: string;
  kind: 'job' | 'project' | 'runner' | 'schedule' | 'integration_binding' | 'outbox_delivery';
  label: string;
}

/** One of the six Tier 1 alerts, from `GET /api/admin/alerts`. */
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

export { ADMIN_THRESHOLD_DEFAULTS, type AdminThresholds } from '../admin-thresholds/index.js';
