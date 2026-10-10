/**
 * ISS-652 — Tier 1 alert engine, single source of truth. `computeAlerts` is
 * called by BOTH `admin/routes.ts` (pull, GET /api/admin/alerts) and
 * `admin/alert-sweeper.ts` (push, writes `notifications`) — neither side ever
 * inlines its own alert query, so pull and push cannot drift apart.
 *
 * Every window cutoff is bound SQL-side (`now() - (n::int * interval ...)`);
 * postgres-js cannot serialize a JS `Date` at Bind time (ISS-267). An id list
 * is bound via `sql.join(...IN (...))`, never `= ANY(${jsArray}::uuid[])`,
 * which drizzle expands as a malformed record tuple.
 */

import { ADMIN_THRESHOLDS, type AdminThresholds } from '../lib/admin-thresholds.js';
import { type OpsAlertChange, opsAlertChanges } from '../notifications/index.js';
import { alertAutomationFailing, alertDeadDeliveries } from './alert-automation-queries.js';
import {
  alertOrphanJobs,
  alertRunnerStarved,
  alertSpendSpike,
  alertStuckJobs,
} from './alert-job-queries.js';
import type { AdminAlert, AdminAlertId, AdminAlertStatus } from './types.js';

interface AlertQueryOptions {
  /** Overrides the configured `stuckJobSeconds` for one call — the `?staleSeconds=` query param. */
  staleSeconds?: number;
  now?: Date;
  thresholds?: AdminThresholds;
}

export function opsAlertResolutionKey(id: AdminAlertId): string {
  return `ops-alert:${id}`;
}

/** Always returns exactly 6 items, ordered A1..A6. Shared by the pull route and the push sweeper. */
export async function computeAlerts(opts: AlertQueryOptions = {}): Promise<AdminAlert[]> {
  const thresholds = opts.thresholds ?? ADMIN_THRESHOLDS;
  const staleSeconds = opts.staleSeconds ?? thresholds.stuckJobSeconds;
  const now = opts.now ?? new Date();
  const read = await Promise.all([
    alertOrphanJobs(),
    alertStuckJobs(staleSeconds),
    alertRunnerStarved(thresholds.runnerStarvedSeconds),
    alertSpendSpike(now, thresholds),
    alertAutomationFailing(thresholds, now),
    alertDeadDeliveries(),
  ]);
  const changes = await opsAlertChanges(read.map((a) => opsAlertResolutionKey(a.id)));
  return read.map((a) => ({
    ...a,
    changedAt: changedAtOf(a.status, changes.get(opsAlertResolutionKey(a.id))),
  }));
}

const SEVERITY_OF: Record<Exclude<AdminAlertStatus, 'ok'>, string> = {
  warn: 'warning',
  crit: 'error',
};

/**
 * When the level shown last changed, read from the sweep's record (REQ-22 BC-1): the open record's
 * change where its severity is the level shown, the last return to ok where the alert reads ok and
 * nothing is open. Anything else is a level the five-minute sweep has not recorded yet: null.
 */
function changedAtOf(status: AdminAlertStatus, change: OpsAlertChange | undefined): string | null {
  if (!change) return null;
  if (status === 'ok') return change.open ? null : (change.resolvedAt?.toISOString() ?? null);
  return change.open?.severity === SEVERITY_OF[status] ? change.open.changedAt.toISOString() : null;
}
