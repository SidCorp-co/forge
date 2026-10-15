import type { StatusKey } from "@/design/status";
import { gateReasonLine } from "@/features/runners/types";
import { formatDurationMs } from "@/lib/utils/format";
import type { PipelineRunStatus, PipelineRunSummary, RunGate, StepDurationRow } from "./types";

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

/** What a run's own summary says its agent is doing: a session beat or a started job is running, only unclaimed jobs is queued, no live job is null. */
export function runSummaryReading(
  run: Pick<PipelineRunSummary, "attempts" | "lastSessionBeatAt">,
): "running" | "queued" | null {
  if (run.lastSessionBeatAt !== null) return "running";
  let queued = false;
  for (const a of run.attempts) {
    if (a.status === "running" || a.status === "dispatched") return "running";
    if (a.status === "queued") queued = true;
  }
  return queued ? "queued" : null;
}

/** The drawer header's chip, one reading on every screen: a running run reads its summary, the issue row only where the summary names no live job. */
export function drawerRunChip(
  run: Pick<PipelineRunSummary, "status" | "attempts" | "lastSessionBeatAt">,
  issueRun: StatusKey | null,
): StatusKey {
  if (run.status !== "running") return runStatusToStatusKey(run.status);
  const reading = runSummaryReading(run);
  if (reading !== null) return reading;
  return issueRun === "running" || issueRun === "queued" ? issueRun : "running";
}

/** Median of a numeric list (`null` for an empty list). Used by the dashboard's
 *  where-time-goes aggregate. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One row of the dashboard's "Where time goes" — a REAL job type over the window. */
export interface StepCost {
  /** The job type exactly as the `step_durations` rows carry it. */
  step: string;
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
      medianSec: median(agg.secs) ?? 0,
      cost: agg.cost,
      samples: agg.secs.length,
    }))
    .sort((a, b) => b.medianSec - a.medianSec || a.step.localeCompare(b.step));
}

/** ISS-1192 — what a reviewer opening a run session is told about the box's
 *  gate. `none` and `clear` are different facts and never share a picture. */
export interface RunGateNote {
  verdict: "none" | "clear" | "marked" | "failing_open" | "unreadable";
  headline: string;
  detail: string;
  reason: string | null;
}

/** The run could not be fetched: the condition is unknown, which is not "none". */
export function runGateUnfetched(message: string): RunGateNote {
  return {
    verdict: "unreadable",
    headline: "This run's record could not be read, so its gate condition is unknown",
    detail: message,
    reason: null,
  };
}

/** `undefined` is a response that did not carry the field, and says nothing. */
export function runGateNote(gate: RunGate | null | undefined): RunGateNote | null {
  if (gate === undefined) return null;
  if (gate === null) {
    return {
      verdict: "none",
      headline: "The box reported no gate condition when this run opened",
      detail: "Its runner sent none, so this record cannot say whether the gate was deciding.",
      reason: null,
    };
  }
  if (gate.read === "unreadable") {
    return {
      verdict: "unreadable",
      headline: "This run recorded a gate condition that cannot be read",
      detail: `${gate.reason} — the run was not opened with no condition, so this is not "the gate was deciding".`,
      reason: null,
    };
  }
  const c = gate.condition;
  if (c.verdict === "clear") {
    return {
      verdict: "clear",
      headline: "This box's gate was deciding when this run opened",
      detail: "No dispatch on record had gone through without a decision.",
      reason: null,
    };
  }
  const rate = c.perDay === null ? "at an unstated rate" : `${Math.round(c.perDay)}/day`;
  const window = c.windowMs === null ? "an unknown span" : formatDurationMs(c.windowMs);
  return {
    verdict: c.verdict,
    headline:
      c.verdict === "failing_open"
        ? "This box's gate was failing open when this run opened"
        : "This box's gate had admitted undecided dispatches when this run opened",
    detail: `${c.count} dispatch(es) admitted without a decision, ${rate} over ${window}`,
    reason: gateReasonLine(c.byReason, c.count),
  };
}
