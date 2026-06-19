// web-v2 feature module: pipeline — PURE derivations (no React, no fetching).
// Status → stage / chip / tracker-state mappings, run/issue overlays, and the
// money/duration formatters used across the kanban, run detail, and ops views.
import { type StageKey, STAGES } from "@/design/stages";
import type { StatusKey } from "@/design/status";
import type {
  PipelineIssueRow,
  PipelineRunListItem,
  PipelineRunStatus,
  StepDurationRow,
} from "./types";

/** Tracker run-state vocabulary (see `PipelineTracker`). */
export type TrackerRunState = "running" | "done" | "failed" | "blocked" | "queued" | "review";

/**
 * Map a core issue status to a pipeline stage. Ported from the project
 * overview's STATUS_TO_STAGE (`projects/[slug]/page.tsx`) and extended to cover
 * every status so no issue ever falls off the board.
 */
export const STATUS_TO_STAGE: Record<string, StageKey> = {
  open: "triage",
  needs_info: "triage",
  confirmed: "clarify",
  clarified: "plan",
  draft: "triage",
  waiting: "plan",
  approved: "plan",
  in_progress: "code",
  reopen: "code",
  on_hold: "code",
  developed: "review",
  deploying: "test",
  testing: "test",
  tested: "test",
  released: "release",
  closed: "release",
};

export function statusToStage(status: string): StageKey {
  return STATUS_TO_STAGE[status] ?? "triage";
}

/** A run's `currentStep` (a `jobType`) → pipeline stage. `fix` folds onto
 *  `code`; `custom`/`pm` have no board column, so default to `triage`. */
export function jobTypeToStage(jobType: string | null | undefined): StageKey {
  switch (jobType) {
    case "triage":
    case "clarify":
    case "plan":
    case "code":
    case "review":
    case "test":
    case "release":
      return jobType;
    case "fix":
      return "code";
    default:
      return "triage";
  }
}

/** Map a run status to the design-kit `StatusKey` vocabulary (chip + card). */
export function runStatusToStatusKey(status: PipelineRunStatus): StatusKey {
  switch (status) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "blocked";
  }
}

/** Map a run status to the `PipelineTracker` run-state. */
export function runStatusToTracker(status: PipelineRunStatus): TrackerRunState {
  switch (status) {
    case "running":
      return "running";
    case "paused":
      return "queued";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "blocked";
  }
}

/**
 * Resting chip status for an issue with no active run — mirrors the issues
 * table's `statusToChip` so the board and the table agree.
 */
export function issueStatusToStatusKey(status: string): StatusKey {
  switch (status) {
    case "in_progress":
    case "deploying":
    case "testing":
      return "running";
    case "developed":
      return "review";
    case "tested":
      return "passed";
    case "released":
    case "closed":
      return "done";
    case "waiting":
    case "needs_info":
      return "waiting";
    case "reopen":
      return "blocked";
    case "on_hold":
      return "paused";
    default:
      return "queued";
  }
}

/** Format an estimated cost in USD. `$X.XX`, with small-value and zero cases. */
export function formatUsd(usd: number | null | undefined): string {
  if (usd == null) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Human duration from milliseconds: `820ms` · `4.2s` · `3m 12s` · `1h 04m`. */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Human duration from seconds (step-durations view). */
export function formatDurationSec(sec: number | null | undefined): string {
  if (sec == null) return "—";
  return formatDurationMs(sec * 1000);
}

/**
 * Index the per-project runs list by `issueId`, keeping the most recent run per
 * issue. The list arrives ordered by `startedAt` desc, so the first run seen
 * for an issue is the latest — later ones are dropped.
 */
export function runsByIssue(
  runs: PipelineRunListItem[] | undefined,
): Map<string, PipelineRunListItem> {
  const map = new Map<string, PipelineRunListItem>();
  for (const run of runs ?? []) {
    if (run.issueId && !map.has(run.issueId)) map.set(run.issueId, run);
  }
  return map;
}

export interface StageGroup {
  stage: StageKey;
  issues: PipelineIssueRow[];
}

/** Group issues into the 7 ordered `STAGES` columns via `STATUS_TO_STAGE`. */
export function groupIssuesByStage(issues: PipelineIssueRow[] | undefined): StageGroup[] {
  const buckets = new Map<StageKey, PipelineIssueRow[]>(STAGES.map((s) => [s.key, []]));
  for (const issue of issues ?? []) {
    buckets.get(statusToStage(issue.status))?.push(issue);
  }
  return STAGES.map((s) => ({ stage: s.key, issues: buckets.get(s.key) ?? [] }));
}

/** Median of a numeric list (`null` for an empty list). Used by the Issues
 *  Insights view's per-stage / where-time-goes aggregates. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One per-stage row for the Issues Insights funnel. `count` is how many issues
 *  currently sit in the stage; `medianSec`/`cost`/`samples` come from the
 *  `step-durations` window (null median when the window has no rows for it). */
export interface StageInsight {
  stage: StageKey;
  label: string;
  color: string;
  count: number;
  medianSec: number | null;
  cost: number;
  samples: number;
}

/**
 * Combine the per-stage issue counts (from `groupIssuesByStage`) with the
 * `step-durations` window (median duration + summed cost per stage) into the 7
 * ordered `STAGES` rows the Insights view renders. Step rows are folded onto a
 * stage via `jobTypeToStage` (so `fix` rolls into `code`).
 */
export function aggregateStageInsights(
  groups: StageGroup[],
  durations: StepDurationRow[] | undefined,
): StageInsight[] {
  const byStage = new Map<StageKey, { secs: number[]; cost: number }>();
  for (const r of durations ?? []) {
    const stage = jobTypeToStage(r.step);
    const cur = byStage.get(stage) ?? { secs: [], cost: 0 };
    cur.secs.push(r.durationSeconds);
    cur.cost += r.costUsd;
    byStage.set(stage, cur);
  }
  const countByStage = new Map(groups.map((g) => [g.stage, g.issues.length]));
  return STAGES.map((s) => {
    const agg = byStage.get(s.key);
    return {
      stage: s.key,
      label: s.label,
      color: s.color,
      count: countByStage.get(s.key) ?? 0,
      medianSec: agg ? median(agg.secs) : null,
      cost: agg?.cost ?? 0,
      samples: agg?.secs.length ?? 0,
    };
  });
}

/** Two-letter avatar initials from an assignee id / email. */
export function initialsFor(id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  const local = id.includes("@") ? (id.split("@")[0] ?? id) : id;
  const parts = local.split(/[._\- ]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}
