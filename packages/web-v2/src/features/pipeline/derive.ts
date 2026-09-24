import {
  AUTONOMOUS_LABELS,
  type AutonomousLabel,
  toAutonomousLabel,
} from "@forge/contracts/issue-vocabulary";
import { REGISTRY_ISSUE_STATUSES } from "@forge/contracts/pipeline-registry";
import { deriveQueuedStep, hasLiveAgentSession, queuedChipStatus } from "@/features/issues/waiting";
import { LABEL_VIEW, statusToChip } from "@/features/issues/derive";
import { type SemanticTone, type StatusKey, TONE_META } from "@/design/status";
import type { IssueStatus } from "@/features/issues/types";
import { type StageKey, stageColor } from "@/design/stages";
import {
  BOARD_EXCLUDED_STATUSES,
  type PipelineIssueRow,
  type PipelineRunListItem,
  type PipelineRunStatus,
  type RunGate,
  type RunGateCondition,
  type StepDurationRow,
} from "./types";

export function jobTypeToStage(jobType: string | null | undefined): StageKey | null {
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
      return null;
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

/** One column of the board: a lane label, the word and colour it reads in, and its issues. */
export interface LabelGroup {
  label: AutonomousLabel;
  title: string;
  color: string;
  issues: PipelineIssueRow[];
}

/**
 * The board's columns: every lane label that a status the board's own query CAN RETURN maps to,
 * kept in `AUTONOMOUS_LABELS`' order.
 *
 * Derived forward from the returnable statuses, never by subtracting the excluded ones' labels.
 * The two are different relations: `toAutonomousLabel` is many-to-one, so the moment an excluded
 * status shares a label with an included one, subtraction deletes a column full of live issues.
 */
export function boardColumns(
  excluded: readonly string[] = BOARD_EXCLUDED_STATUSES,
): AutonomousLabel[] {
  const reachable = new Set<AutonomousLabel>();
  for (const status of REGISTRY_ISSUE_STATUSES) {
    if (excluded.includes(status)) continue;
    reachable.add(toAutonomousLabel(status, true));
    reachable.add(toAutonomousLabel(status, false));
  }
  return AUTONOMOUS_LABELS.filter((l) => reachable.has(l));
}

/** The colour a lane label reads in — the same `SemanticTone` its status chip resolves through. */
export function labelTone(label: AutonomousLabel): SemanticTone {
  return LABEL_VIEW[label].tone;
}

/** The lane label a board row reads: its status, and whether anything is on it now. */
export function rowLabel(issue: PipelineIssueRow): AutonomousLabel {
  return toAutonomousLabel(issue.status as (typeof REGISTRY_ISSUE_STATUSES)[number], issue.held);
}

/** Group issues into the board's columns by the label each row reads as. */
export function groupIssuesByLabel(issues: PipelineIssueRow[] | undefined): LabelGroup[] {
  const columns = boardColumns();
  const buckets = new Map<AutonomousLabel, PipelineIssueRow[]>(columns.map((l) => [l, []]));
  for (const issue of issues ?? []) {
    const label = rowLabel(issue);
    const bucket = buckets.get(label);
    if (bucket) bucket.push(issue);
    else buckets.set(label, [issue]);
  }
  return [...buckets.entries()].map(([label, list]) => ({
    label,
    title: LABEL_VIEW[label].label,
    color: TONE_META[LABEL_VIEW[label].tone].dot,
    issues: list,
  }));
}

/** Median of a numeric list (`null` for an empty list). Used by the Issues
 *  Insights view's per-stage / where-time-goes aggregates. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One row of the Insights view's "Where time goes" — a REAL job type over the window. */
export interface StepCost {
  /** The job type exactly as the `step_durations` rows carry it. */
  step: string;
  /** The seven-name colour when this job type is one of them, a neutral token when it is not. */
  color: string;
  medianSec: number;
  cost: number;
  samples: number;
}

/**
 * Fold the `step-durations` window onto the job types it actually contains, slowest median first.
 */
export function aggregateStepCosts(durations: StepDurationRow[] | undefined): StepCost[] {
  const byStep = new Map<string, { secs: number[]; cost: number }>();
  for (const r of durations ?? []) {
    const cur = byStep.get(r.step) ?? { secs: [], cost: 0 };
    cur.secs.push(r.durationSeconds);
    cur.cost += r.costUsd;
    byStep.set(r.step, cur);
  }
  return [...byStep.entries()]
    .map(([step, agg]) => ({
      step,
      color: stageColor(step),
      medianSec: median(agg.secs) ?? 0,
      cost: agg.cost,
      samples: agg.secs.length,
    }))
    .sort((a, b) => b.medianSec - a.medianSec || a.step.localeCompare(b.step));
}

/** Everything a kanban card's status chip needs, from the three signals that
 *  can claim it: a queued step, the issue's live run, and the issue's own
 *  lifecycle status. */
export interface CardStatusView {
  status: StatusKey;
  /** Undefined lets `StatusChip` use the run vocabulary's own label. */
  label: string | undefined;
  domain: "session" | "issue";
  /** The gate sentence, for the card's tooltip + aria-label; "" when none. */
  waitingReason: string;
}

/** ISS-1192 — what a reviewer opening this run is told about the box's gate.
 *  `null` where it was deciding, and where the box reported nothing. */
export interface RunGateNote {
  verdict: "marked" | "failing_open" | "unreadable";
  headline: string;
  detail: string;
  reason: string | null;
}

/** The largest count, taken rather than assumed: nothing between the box and
 *  here declares the breakdown's order, and the wrong cause sends a reader at
 *  the wrong remedy. */
function commonestReason(by: RunGateCondition["byReason"]) {
  return by.reduce<RunGateCondition["byReason"][number] | undefined>((best, r) => {
    if (best === undefined) return r;
    if (r.count !== best.count) return r.count > best.count ? r : best;
    return r.reason < best.reason ? r : best;
  }, undefined);
}

export function runGateNote(gate: RunGate | null | undefined): RunGateNote | null {
  if (!gate) return null;
  if (gate.read === "unreadable") {
    return {
      verdict: "unreadable",
      headline: "This run recorded a gate condition that cannot be read",
      detail: `${gate.reason} — the run was not opened with no condition, so this is not "the gate was deciding".`,
      reason: null,
    };
  }
  const c = gate.condition;
  if (c.verdict === "clear") return null;
  const rate = c.perDay === null ? "at an unstated rate" : `${Math.round(c.perDay)}/day`;
  const window = c.windowMs === null ? "an unknown span" : formatDurationMs(c.windowMs);
  const top = commonestReason(c.byReason);
  return {
    verdict: c.verdict,
    headline:
      c.verdict === "failing_open"
        ? "This box's gate was failing open when this run opened"
        : "This box's gate had admitted undecided dispatches when this run opened",
    detail: `${c.count} dispatch(es) admitted without a decision, ${rate} over ${window}`,
    reason: top?.count === c.count ? `every one of them: ${top.reason}` : (top?.reason ?? null),
  };
}

export function cardStatus(
  issue: PipelineIssueRow,
  run: { status: PipelineRunStatus } | undefined,
): CardStatusView {
  const queued = deriveQueuedStep(issue.pipelineHealth, hasLiveAgentSession(issue.agentStatus));
  if (queued) {
    return {
      status: queuedChipStatus(queued),
      label: queued.gate?.short ?? "Queued",
      domain: "session",
      waitingReason: queued.gate?.detail ?? "",
    };
  }
  if (run) {
    return {
      status: runStatusToStatusKey(run.status),
      label: undefined,
      domain: "session",
      waitingReason: "",
    };
  }
  const label = rowLabel(issue);
  return {
    status: label === "stalled" ? LABEL_VIEW.stalled.status : statusToChip(issue.status as IssueStatus),
    label: LABEL_VIEW[label].label,
    domain: "issue",
    waitingReason: "",
  };
}
