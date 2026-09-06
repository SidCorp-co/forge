/**
 * Response shapes for the cross-tenant Operator Ops Console endpoints
 * (ISS-649). A leaf module with no imports: `public.ts` re-exports it, and
 * `@forge/contracts` re-exports that, so the browser and the handlers read one
 * declaration instead of two that drift.
 */

/** One Tier 2 glance metric: the window's value, its move against the
 *  preceding window of equal length, and a dense per-bucket series for the
 *  current window. `value`/`deltaPct` are null where the denominator was zero
 *  — a ratio nobody can compute, not a zero. */
export interface AdminGlanceMetric {
  value: number | null;
  deltaPct: number | null;
  spark: number[];
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
  glance: {
    leadTimeMinutes: AdminGlanceMetric;
    interventionsPerClosed: AdminGlanceMetric;
    costPerClosedUsd: AdminGlanceMetric;
    successRatePct: AdminGlanceMetric;
    signupsWindow: AdminGlanceMetric;
  };
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
