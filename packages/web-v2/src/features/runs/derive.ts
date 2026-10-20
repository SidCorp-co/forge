import type { StatusKey } from "@/design/status";
import { sessionStatusLabel } from "@/design/primitives/status-chip";
import { gateReasonLine } from "@/features/runners/types";
import {
  blockedHoldingText,
  checkInByText,
  GATE_TEXT,
  gateAdmittedText,
  gateReasonText,
  gateUnreadableDetailText,
  heldText,
  parkedText,
} from "@/features/sessions/status-sentences";
import { formatDurationMs, formatElapsed } from "@/lib/utils/format";
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

/** A run's word on every surface, and the sentence its hover reads. */
export interface RunWord {
  status: StatusKey;
  label: string;
  detail?: string;
}

const OPEN_RUN_WORD: Record<Exclude<RunReading, "running" | "blocked" | "held">, RunWord> = {
  starting: { status: "queued", label: "Starting" },
  queued: { status: "queued", label: "Queued" },
  waiting: { status: "waiting", label: sessionStatusLabel("waiting") },
};

const RUN_START_GRACE_MS = 3 * 60_000;

type RunLiveFields = Pick<PipelineRunSummary, "status" | "reading" | "liveJobs" | "lastSessionBeatAt" | "startedAt"> &
  Partial<Pick<PipelineRunSummary, "hold" | "block" | "checkInBy" | "runningSince">>;

/** Core ends a silent session itself, so a session it holds open is an agent behind the run. */
export function sessionIsBeating(run: Pick<PipelineRunSummary, "lastSessionBeatAt">): boolean {
  return run.lastSessionBeatAt != null && !Number.isNaN(Date.parse(run.lastSessionBeatAt));
}

function startingUp(run: RunLiveFields, nowMs: number): boolean {
  const started = Date.parse(run.startedAt);
  return !Number.isNaN(started) && nowMs - started <= RUN_START_GRACE_MS;
}

/** A running run past its start-up grace with no agent, live job or beating session; the band, rows
 *  and drawer header all ask this one test (ISS-1228). */
export function runIsStalled(run: RunLiveFields, nowMs: number): boolean {
  return (
    run.status === "running" &&
    run.reading == null &&
    (run.liveJobs ?? 0) === 0 &&
    !sessionIsBeating(run) &&
    !startingUp(run, nowMs)
  );
}

function unreadRunWord(run: RunLiveFields, nowMs: number): RunWord {
  if (runIsStalled(run, nowMs)) return { status: "zombie", label: "Nothing working" };
  if ((run.liveJobs ?? 0) === 0 && !sessionIsBeating(run)) return OPEN_RUN_WORD.starting;
  return { status: "running", label: RUN_STATUS_WORD.running };
}

/** When core next tries a hold that waits out a clock, as a reader's clock reads it. */
function recheckClock(at: string | null | undefined): string | null {
  if (!at) return null;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** A held step's sentence, the drawer's activity row and the run's hover alike (ISS-1228 round 19). */
export const holdSentence = (hold: PipelineRunSummary["hold"]): string => heldText(hold, recheckClock(hold?.recheckAt));

/** A run a box reports blocked: its word by whether the box's process is gone and who holds the wait. */
function blockedWord(block: PipelineRunSummary["block"]): RunWord {
  const kind = block?.blockerKind ?? null;
  if (block?.parked) {
    return { status: "blocked", label: kind === "human" ? "Parked for a person" : "Parked", detail: parkedText(kind) };
  }
  return { status: "blocked", label: "Blocked, holding the box", detail: blockedHoldingText(kind) };
}

/** A starting run's hover: how long core waits for a session that has not checked in. */
function startingWord(run: RunLiveFields, nowMs: number): RunWord {
  if (!run.checkInBy) return OPEN_RUN_WORD.starting;
  const left = Date.parse(run.checkInBy) - nowMs;
  return { ...OPEN_RUN_WORD.starting, detail: checkInByText(left > 0 ? formatElapsed(left) : null) };
}

/** The one word a run reads on every surface — the runs tab, the drawer's header and open attempt, the
 *  issue page — an open run by what core says its agent is doing, any other by its own status (ISS-1228). */
export function runReadingChip(run: RunLiveFields, nowMs: number): RunWord {
  if (run.status !== "running" || run.reading === "running") {
    return { status: runStatusToStatusKey(run.status), label: RUN_STATUS_WORD[run.status] };
  }
  switch (run.reading) {
    case null:
    case undefined:
      return unreadRunWord(run, nowMs);
    case "held":
      return { status: "paused", label: "Held", detail: holdSentence(run.hold ?? null) };
    case "blocked":
      return blockedWord(run.block ?? null);
    case "starting":
      return startingWord(run, nowMs);
    default:
      return OPEN_RUN_WORD[run.reading];
  }
}

/** Whether anything has started on an open run: an agent working or waiting on someone, or a chat
 *  waiting on its person. */
export const runHasStarted = (run: Pick<PipelineRunSummary, "status" | "reading">): boolean =>
  run.status === "running" && (run.reading === "running" || run.reading === "waiting" || run.reading === "blocked");

/** A run's time: its first start once anything started on it (queued again, it still started), else its opening. */
export function runSince(run: RunLiveFields, nowMs: number): { word: "Started" | "Opened"; at: string } {
  if (run.runningSince) return { word: "Started", at: run.runningSince };
  const working = run.status !== "running" || runHasStarted(run) || runReadingChip(run, nowMs).label === RUN_STATUS_WORD.running;
  // An older core answers no start of work; its opening is all there is to say it from.
  if (working) return { word: "Started", at: run.runningSince ?? run.startedAt };
  return { word: "Opened", at: run.startedAt };
}

/** What a run's time is called: Opened until its work starts, Started once it has (`runSince`). */
export function runSinceWord(run: RunLiveFields, nowMs: number): string {
  return runSince(run, nowMs).word;
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
