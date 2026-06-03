// web-v2 feature module: overview — pure derivation helpers for the workspace
// dashboard. All functions are pure (no React, no I/O) so the dashboard's
// aggregation logic — status bucketing, spotlight ranking, workspace KPIs — is
// unit-testable in `derive.test.ts` without rendering anything.
//
// Everything here re-composes data already fetched by the existing
// `useProjectsConsole` / `useProjectHealth` hooks. No new data sources.
import type { ProjectConsoleItem, ProjectHealthRow, WorkspaceTotals } from '@/features/projects/types';
import { isAttention } from '@/features/projects/derive';

/**
 * Sum a list of per-project `statusDistribution` maps into one workspace-wide
 * status→count map. Missing keys default to 0; the result only carries statuses
 * that appear in at least one project.
 */
export function aggregateStatusDistribution(
  rows: ProjectHealthRow[] | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows ?? []) {
    for (const [status, count] of Object.entries(r.statusDistribution ?? {})) {
      out[status] = (out[status] ?? 0) + count;
    }
  }
  return out;
}

/** One display bucket on the work-distribution bar. */
export interface WorkBucket {
  key: string;
  label: string;
  /** CSS color token for the bar segment + legend swatch. */
  color: string;
  /** Issue statuses folded into this bucket. */
  statuses: readonly string[];
  count: number;
}

/**
 * Workspace work buckets, in pipeline order. We deliberately fold the 18 issue
 * statuses into 6 meaningful "where does the work sit" buckets and EXCLUDE the
 * terminal `closed`/`draft` statuses — including them would let long-closed work
 * dominate the bar and drown out the in-flight signal the overview is for.
 */
const BUCKET_DEFS: ReadonlyArray<Omit<WorkBucket, 'count'>> = [
  { key: 'backlog', label: 'Backlog', color: 'var(--ink-400)', statuses: ['open', 'confirmed'] },
  { key: 'planning', label: 'Planning', color: 'var(--cobalt-500)', statuses: ['clarified', 'waiting', 'approved'] },
  { key: 'progress', label: 'In progress', color: 'var(--accent)', statuses: ['in_progress', 'reopen'] },
  { key: 'review', label: 'Review & QA', color: 'var(--amberw-500)', statuses: ['developed', 'deploying', 'testing', 'tested'] },
  { key: 'ready', label: 'Ready to ship', color: 'var(--green-500)', statuses: ['pass', 'staging', 'released'] },
  { key: 'blocked', label: 'Blocked', color: 'var(--red-500)', statuses: ['on_hold', 'needs_info'] },
];

/**
 * Fold an aggregated status distribution into the display buckets above. Always
 * returns all buckets in pipeline order (callers filter `count > 0` for
 * rendering); the `total` is the sum of bucketed counts only (closed/draft are
 * intentionally not counted).
 */
export function groupWorkBuckets(dist: Record<string, number>): {
  buckets: WorkBucket[];
  total: number;
} {
  let total = 0;
  const buckets = BUCKET_DEFS.map((def) => {
    let count = 0;
    for (const s of def.statuses) count += dist[s] ?? 0;
    total += count;
    return { ...def, count };
  });
  return { buckets, total };
}

/**
 * Rank projects for the dashboard spotlight: needs-attention first, then most
 * recent activity (nulls last), capped at `limit`. Non-mutating.
 */
export function pickSpotlightProjects(
  items: ProjectConsoleItem[],
  limit: number,
): ProjectConsoleItem[] {
  const recency = (p: ProjectConsoleItem) => (p.lastActivityAt ? Date.parse(p.lastActivityAt) : 0);
  return [...items]
    .sort((a, b) => {
      const aAtt = isAttention(a) ? 0 : 1;
      const bAtt = isAttention(b) ? 0 : 1;
      if (aAtt !== bAtt) return aAtt - bAtt;
      return recency(b) - recency(a);
    })
    .slice(0, Math.max(0, limit));
}

/** Workspace KPIs = the stats-band totals widened with health rollups. */
export interface WorkspaceKpis extends WorkspaceTotals {
  /** Resolved issues in the trailing 7d window (summed across projects). */
  throughput: number;
  /** Mean cycle time (days) over projects that have a value, or null. */
  avgCycleTimeDays: number | null;
  /** Projects currently flagged needs-attention. */
  attentionProjects: number;
}

/**
 * Extend `workspaceTotals` with health-derived aggregates: summed throughput,
 * the mean cycle time over projects that actually resolved something (so a
 * fleet of zero-data projects doesn't drag the mean to a misleading 0), and the
 * needs-attention project count.
 */
export function workspaceKpis(
  totals: WorkspaceTotals,
  items: ProjectConsoleItem[],
  healthRows: ProjectHealthRow[] | undefined,
): WorkspaceKpis {
  const rows = healthRows ?? [];
  let throughput = 0;
  let cycleSum = 0;
  let cycleN = 0;
  for (const r of rows) {
    throughput += r.throughput ?? 0;
    if (Number.isFinite(r.avgCycleTimeDays) && r.avgCycleTimeDays > 0) {
      cycleSum += r.avgCycleTimeDays;
      cycleN += 1;
    }
  }
  return {
    ...totals,
    throughput,
    avgCycleTimeDays: cycleN > 0 ? cycleSum / cycleN : null,
    attentionProjects: items.filter(isAttention).length,
  };
}
