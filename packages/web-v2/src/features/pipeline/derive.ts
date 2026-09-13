// cm:guard PURE derivations only — no React, no fetching. This module holds the board's column derivation, the status→chip mapping and the money/duration formatters used by the kanban, run detail and ops views, so one import with a side effect reaches all three at once.
// cm:guard this file's own STATUS_TO_STAGE went in ISS-999, with its 15 keys against the issues module's 17 — `releasing` and `dropped` were in neither, so both fell through `?? "triage"` and the same issue read `release` on its row and `triage` on the board. The columns are the lane's labels now and the lane is the kernel's: a map from status to a position does not come back here under another name.
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
  type StepDurationRow,
} from "./types";

/** A run's `currentStep` (a `jobType`) → one of the seven staged names, for COLOUR. `fix` folds
 *  onto `code`; anything else — `drive`, `pm`, `custom` — is not one of the seven and answers
 *  `null`, so a caller shows the job type's own name rather than a seven's. */
// cm:guard the `default` used to answer `triage`, which is why every autonomous run (whose only job type is `drive`) painted the first bead of a seven-bead tracker as its position. ISS-999 deleted that tracker and this answers `null` instead: a name outside the seven is reported as outside the seven, never folded onto the first one.
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
// cm:edge contract -> packages/contracts/src/issue-vocabulary.ts#KERNEL_TO_LABEL — the kernel owns which label a status reads as, and this owns only which of those labels the board can show. A label added there reaches the board with no edit here, provided some returnable status maps to it.
// cm:why `excluded` is a parameter and not read straight off the import: with today's enum the forward derivation and a subtract-the-excluded-labels one agree, because `draft` and `closed` each wear a label no other status wears — so a test over the real set cannot tell a correct implementation from the wrong one, and measured nothing. Passing an excluded set where one excluded status SHARES a label with an included one (`waiting` and `needs_info` are both `needs_human`) separates them, and `board-columns.test.ts` does exactly that.
export function boardColumns(
  excluded: readonly string[] = BOARD_EXCLUDED_STATUSES,
): AutonomousLabel[] {
  const reachable = new Set<AutonomousLabel>();
  for (const status of REGISTRY_ISSUE_STATUSES) {
    if (excluded.includes(status)) continue;
    reachable.add(toAutonomousLabel(status));
  }
  return AUTONOMOUS_LABELS.filter((l) => reachable.has(l));
}

/** The colour a lane label reads in — the same `SemanticTone` its status chip resolves through. */
export function labelTone(label: AutonomousLabel): SemanticTone {
  return LABEL_VIEW[label].tone;
}

/** Group issues into the board's columns by the label their status reads as. */
export function groupIssuesByLabel(issues: PipelineIssueRow[] | undefined): LabelGroup[] {
  const columns = boardColumns();
  const buckets = new Map<AutonomousLabel, PipelineIssueRow[]>(columns.map((l) => [l, []]));
  for (const issue of issues ?? []) {
    // cm:guard a status with no column gets one rather than being dropped — reachable only if the query's `statusNot` and BOARD_EXCLUDED_STATUSES drift apart, and a silently missing row is the worse failure
    const label = toAutonomousLabel(issue.status as (typeof REGISTRY_ISSUE_STATUSES)[number]);
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
// cm:guard keyed on the row's own `step` and NOT on a stage. Its predecessor (aggregateStageInsights, ISS-999) returned one row per seven fixed stages whichever of them had run, with an issue count taken from a status→stage map beside it; a `drive` step landed on `triage` and a stage nothing had run still drew a card. A job type with no row here has no row here.
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

// cm:guard a queued step OUTRANKS the run's own status — a queued job lives under a `running` pipeline_run, so `runStatusToStatusKey` painted the card "Running" while nothing was running, and a waiting chip merely added beside it would have left the card asserting both (ISS-903)
export function cardStatus(
  issue: PipelineIssueRow,
  run: { status: PipelineRunStatus } | undefined,
  labelStatus: (s: IssueStatus) => string,
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
  return {
    status: statusToChip(issue.status as IssueStatus),
    label: labelStatus(issue.status as IssueStatus),
    domain: "issue",
    waitingReason: "",
  };
}
