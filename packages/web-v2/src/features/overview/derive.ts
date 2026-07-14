// web-v2 feature module: overview — pure derivation helpers for the workspace
// dashboard. All functions are pure (no React, no I/O) so the dashboard's
// aggregation logic — status bucketing, spotlight ranking, workspace KPIs — is
// unit-testable in `derive.test.ts` without rendering anything.
//
// Everything here re-composes data already fetched by the existing
// `useProjectsConsole` / `useProjectHealth` hooks. No new data sources.
import { TONE_META, type SemanticTone } from '@/design/status';
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
 * Workspace work buckets, in pipeline order. ISS-509: buckets are grouped by
 * SEMANTIC TONE and colored from `TONE_META` (one source of truth) — so a status
 * lands on the SAME color here as in its chip and in the project-dashboard donut
 * (e.g. `reopen` is `active`/cobalt in all three; `on_hold` is calm `blocked`
 * ink, NOT red). The terminal `closed`/`draft` statuses are still EXCLUDED —
 * including them would let long-closed work dominate the bar and drown out the
 * in-flight signal the overview is for. `waiting`/`needs_info` (a human must act)
 * split out of the old red "Blocked" lump into their own `attention` bucket.
 */
const BUCKET_DEFS: ReadonlyArray<Omit<WorkBucket, 'count' | 'color'> & { tone: SemanticTone }> = [
  { key: 'queued', label: 'Queued', tone: 'neutral', statuses: ['open', 'confirmed', 'clarified', 'approved'] },
  { key: 'progress', label: 'In progress', tone: 'active', statuses: ['in_progress', 'reopen', 'developed', 'testing'] },
  { key: 'attention', label: 'Needs attention', tone: 'attention', statuses: ['waiting', 'needs_info'] },
  { key: 'ready', label: 'Ready to ship', tone: 'success', statuses: ['tested', 'released'] },
  { key: 'blocked', label: 'On hold', tone: 'blocked', statuses: ['on_hold'] },
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
    const { tone, ...rest } = def;
    return { ...rest, color: TONE_META[tone].dot, count };
  });
  return { buckets, total };
}

/** One project's row on the per-project Workload panel. */
export interface ProjectWorkload {
  project: ProjectConsoleItem;
  buckets: WorkBucket[];
  total: number;
}

/**
 * ISS-665 — replaces the workspace-wide aggregate bar (which could not answer
 * "which project is overloaded") AND the Spotlight panel (its project-level
 * signal — attention + recency — is folded in here via the sort). Buckets
 * each in-scope project's OWN `statusDistribution` (falling back to empty when
 * its health row hasn't loaded/doesn't exist), ranks needs-attention first
 * then most in-flight work, capped at `limit`. Non-mutating.
 */
export function perProjectWorkload(
  items: ProjectConsoleItem[],
  healthRows: ProjectHealthRow[] | undefined,
  limit: number,
): ProjectWorkload[] {
  const distByProjectId = new Map<string, Record<string, number>>();
  for (const r of healthRows ?? []) {
    distByProjectId.set(r.id, r.statusDistribution ?? {});
  }
  return items
    .map((project) => {
      const { buckets, total } = groupWorkBuckets(distByProjectId.get(project.id) ?? {});
      return { project, buckets, total };
    })
    .sort((a, b) => {
      const aAtt = isAttention(a.project) ? 0 : 1;
      const bAtt = isAttention(b.project) ? 0 : 1;
      if (aAtt !== bAtt) return aAtt - bAtt;
      return b.total - a.total;
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
