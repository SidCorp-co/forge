
import { jobKindLabel } from "@/features/overview/job-kinds";
import {
  FAILURE_CAUSE_PRESENTATION,
  type FailureCause,
  LEGACY_NEUTRAL_REASONS,
  resolveFailureCause,
} from "@forge/contracts/failure-causes";
import { LIVE_JOB_STATUSES } from "@forge/contracts/status-sets";
import { failureReasonAction, failureReasonLabel } from "@/features/sessions/types";
import type { PipelineRunAttempt } from "./types";

/** How an entry reads. `failure` is the only red; `open` is a live attempt. */
export type ActivityTone = "failure" | "swept" | "cleanup" | "success" | "open";

/** The two-value filter above the feed. `failures` is "failures rise". */
export type ActivityFilter = "all" | "failures";

export interface ActivityEntry {
  /** Stable React key — the first job id of the group. */
  key: string;
  /** Verb: what the fleet did. */
  verb: string;
  /** Object: which step it did it to. */
  object: string;
  /** Outcome: how it ended, in English, never a raw token. */
  outcome: string;
  /** The resolved ISS-877 cause, or null when nothing failed. */
  cause: FailureCause | null;
  /** One-line remedy for that cause; null when there is nothing to act on. */
  action: string | null;
  detail: string | null;
  tone: ActivityTone;
  /** Runner the attempt landed on, already resolved to something printable. */
  device: string;
  /** How many consecutive attempts this one line stands for. */
  repeats: number;
  /** 1-based positions in the run's attempt order that this line covers. */
  positions: number[];
  /** When the group ended (or was queued, for an attempt still open). */
  at: string | null;
  /** Whether this is a live attempt with no outcome yet. */
  open: boolean;
}

const OPEN_STATUSES: ReadonlySet<string> = new Set(LIVE_JOB_STATUSES);

/** The box an attempt is on, by name where core knows one; a taken job is on the box that took it. */
function boxOf(a: PipelineRunAttempt): string | null {
  if (a.deviceName) return a.deviceName;
  if (a.deviceId) return a.deviceId.slice(0, 8);
  if (a.takenBy) return a.takenBy.deviceName ?? a.takenBy.deviceId.slice(0, 8);
  return null;
}

/** Runner-friendly device name, never a bare empty cell. */
const deviceLabel = (a: PipelineRunAttempt): string => boxOf(a) ?? "unassigned";

/** An open attempt reads the run's own word for it — Running, Starting where a box has taken or been
 *  sent it, Queued where none has, Held — and a finished one that no box ever started reads Never
 *  started: never Ran for work that did not run (ISS-1228). */
function stateVerb(a: PipelineRunAttempt): string | null {
  if (a.status === "running") return "Running";
  if (a.status === "dispatched" || (a.status === "queued" && a.takenBy)) return "Starting";
  if (a.status === "queued") return "Queued";
  if (a.status === "held") return "Held";
  if (a.status !== "done" && a.ranAt === null) return "Never started";
  return null;
}

/** An open attempt has no cause and so no remedy, whatever its session ended of: the attempt has
 *  not ended, and a remedy on it would send a person after a failure that has not happened. */
function causeOf(a: PipelineRunAttempt): FailureCause | null {
  if (OPEN_STATUSES.has(a.status)) return null;
  if (a.failureCause) return resolveFailureCause(a.failureCause);
  if (a.status !== "failed" && a.status !== "cancelled") return null;
  if (a.failureReason && LEGACY_NEUTRAL_REASONS.has(a.failureReason)) return null;
  return resolveFailureCause(a.failureReason);
}

function toneOf(a: PipelineRunAttempt, cause: FailureCause | null): ActivityTone {
  if (OPEN_STATUSES.has(a.status)) return "open";
  if (!cause) return a.status === "done" ? "success" : "swept";
  return FAILURE_CAUSE_PRESENTATION[cause];
}

/** Outcome text for an attempt that never finished — never a blank cell, and the box by its name. */
function openOutcome(a: PipelineRunAttempt): string {
  const box = boxOf(a) ?? "a box";
  if (a.status === "running") return "Still running";
  if (a.status === "dispatched") return `Sent to ${box}, not started yet`;
  if (a.status === "held") return "Held — waiting on a gate";
  if (a.takenBy) return `Taken by ${box}, not started yet`;
  return "Queued — no box has taken it yet";
}

function outcomeOf(a: PipelineRunAttempt, cause: FailureCause | null): string {
  if (OPEN_STATUSES.has(a.status)) return openOutcome(a);
  if (cause) return failureReasonLabel(cause) ?? "Unclassified";
  if (a.status === "done") return "Completed";
  if (a.failureReason && LEGACY_NEUTRAL_REASONS.has(a.failureReason)) {
    return failureReasonLabel(a.failureReason) ?? "Not dispatched";
  }
  return `Ended ${a.status}`;
}

function detailOf(a: PipelineRunAttempt, cause: FailureCause | null): string | null {
  if (a.failureDetail) return a.failureDetail;
  if (!a.failureReason) return null;
  if (a.failureReason === cause) return null;
  if (LEGACY_NEUTRAL_REASONS.has(a.failureReason)) return null;
  return a.failureReason;
}

/** Two attempts collapse into one line only when every readable field agrees. */
function signature(
  a: PipelineRunAttempt,
  cause: FailureCause | null,
  outcome: string,
  action: string | null,
): string {
  const fields = [a.jobType, a.status, cause ?? "", outcome, action ?? "", deviceLabel(a)];
  return [...fields, detailOf(a, cause) ?? ""].join("\0");
}

function verbFor(a: PipelineRunAttempt, position: number, repeats: number): string {
  const state = stateVerb(a);
  if (state) return state;
  if (repeats > 1) return "Retried";
  return position === 1 ? "Ran" : "Retried";
}

export function deriveActivityFeed(attempts: PipelineRunAttempt[] | undefined): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  let lastSignature: string | null = null;

  (attempts ?? []).forEach((a, index) => {
    const position = index + 1;
    const cause = causeOf(a);
    const outcome = outcomeOf(a, cause);
    const action = cause ? failureReasonAction(cause, "Retry", a.ranAt != null) : null;
    const sig = signature(a, cause, outcome, action);
    const previous = entries[entries.length - 1];

    if (previous && sig === lastSignature) {
      previous.repeats += 1;
      previous.positions.push(position);
      previous.verb = verbFor(a, position, previous.repeats);
      previous.at = a.finishedAt ?? a.startedAt ?? a.queuedAt ?? previous.at;
      previous.open = OPEN_STATUSES.has(a.status);
      return;
    }

    lastSignature = sig;
    entries.push({
      key: a.jobId,
      verb: verbFor(a, position, 1),
      object: jobKindLabel(a.jobType),
      outcome,
      cause,
      action,
      detail: detailOf(a, cause),
      tone: toneOf(a, cause),
      device: deviceLabel(a),
      repeats: 1,
      positions: [position],
      at: a.finishedAt ?? a.startedAt ?? a.queuedAt,
      open: OPEN_STATUSES.has(a.status),
    });
  });

  return entries;
}

export function isFailureEntry(entry: ActivityEntry): boolean {
  return entry.tone === "failure";
}

export function filterActivity(
  entries: ActivityEntry[],
  filter: ActivityFilter,
): ActivityEntry[] {
  return filter === "failures" ? entries.filter(isFailureEntry) : entries;
}

/** How many distinct causes the run actually died of — the headline that says
 *  whether sixteen attempts were one problem or five. */
export function distinctCauseCount(entries: ActivityEntry[]): number {
  const causes = new Set<FailureCause>();
  for (const e of entries) {
    if (e.cause && isFailureEntry(e)) causes.add(e.cause);
  }
  return causes.size;
}
