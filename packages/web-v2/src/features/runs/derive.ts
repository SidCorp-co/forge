import type { StatusKey } from "@/design/status";
import { sessionStatusLabel } from "@/design/primitives/status-chip";
import { gateReasonLine } from "@/features/runners/types";
import {
  GATE_TEXT,
  gateAdmittedText,
  gateReasonText,
  gateUnreadableDetailText,
} from "@/features/sessions/status-sentences";
import { formatDurationMs } from "@/lib/utils/format";
import { RUN_STATUS_WORD } from "./run-status-words";
import type { PipelineRunStatus, PipelineRunSummary, RunGate, RunReading, StepDurationRow } from "./types";

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

const OPEN_RUN_WORD: Record<Exclude<RunReading, "running">, { status: StatusKey; label: string }> = {
  starting: { status: "queued", label: "Starting" },
  queued: { status: "queued", label: "Queued" },
  waiting: { status: "waiting", label: sessionStatusLabel("waiting") },
};

/** The one word a run reads on every surface, the runs tab and the drawer's header alike: an open run
 *  by what core says its agent is doing, any other by its own status (ISS-1228). */
export function runReadingChip(run: Pick<PipelineRunSummary, "status" | "reading">): {
  status: StatusKey;
  label: string;
} {
  if (run.status !== "running" || run.reading === null || run.reading === "running") {
    return { status: runStatusToStatusKey(run.status), label: RUN_STATUS_WORD[run.status] };
  }
  return OPEN_RUN_WORD[run.reading];
}

/** Whether anything has started on an open run: an agent working, or a chat waiting on its person. */
export const runHasStarted = (run: Pick<PipelineRunSummary, "status" | "reading">): boolean =>
  run.status === "running" && (run.reading === "running" || run.reading === "waiting");

/** What a run's time is: when it opened while nothing has started, when it started once it has. */
export const runSinceWord = (run: Pick<PipelineRunSummary, "status" | "reading">): string =>
  run.status === "running" && (run.reading === "queued" || run.reading === "starting") ? "Opened" : "Started";

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
  return { verdict: "unreadable", headline: GATE_TEXT.unfetched, detail: message, reason: null };
}

/** `undefined` is a response that did not carry the field, and says nothing. Every line is worded in
 *  `status-sentences.ts`, as every sentence about a box is (ISS-1228). */
export function runGateNote(gate: RunGate | null | undefined): RunGateNote | null {
  if (gate === undefined) return null;
  if (gate === null) {
    return { verdict: "none", headline: GATE_TEXT.none, detail: GATE_TEXT.noneDetail, reason: null };
  }
  if (gate.read === "unreadable") {
    return {
      verdict: "unreadable",
      headline: GATE_TEXT.unreadable,
      detail: gateUnreadableDetailText(gate.reason),
      reason: null,
    };
  }
  const c = gate.condition;
  if (c.verdict === "clear") {
    return { verdict: "clear", headline: GATE_TEXT.clear, detail: GATE_TEXT.clearDetail, reason: null };
  }
  const rate = c.perDay === null ? "at an unstated rate" : `${Math.round(c.perDay)}/day`;
  const window = c.windowMs === null ? "an unknown span" : formatDurationMs(c.windowMs);
  const reason = gateReasonLine(c.byReason, c.count);
  return {
    verdict: c.verdict,
    headline: c.verdict === "failing_open" ? GATE_TEXT.failingOpen : GATE_TEXT.marked,
    detail: gateAdmittedText(c.count, rate, window),
    reason: reason === null ? null : gateReasonText(reason),
  };
}
