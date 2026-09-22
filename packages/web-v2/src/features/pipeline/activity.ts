
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

/** Runner-friendly device name, never a bare empty cell. */
function deviceLabel(a: PipelineRunAttempt): string {
  if (a.deviceName) return a.deviceName;
  if (a.deviceId) return a.deviceId.slice(0, 8);
  return "unassigned";
}

function causeOf(a: PipelineRunAttempt): FailureCause | null {
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

/** Outcome text for an attempt that never finished — never a blank cell. */
function openOutcome(status: string): string {
  if (status === "running") return "Still running";
  if (status === "dispatched") return "Sent to a runner, not started yet";
  if (status === "held") return "Held — waiting on a gate";
  return "Queued — no runner has picked it up";
}

function outcomeOf(a: PipelineRunAttempt, cause: FailureCause | null): string {
  if (OPEN_STATUSES.has(a.status)) return openOutcome(a.status);
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
function signature(a: PipelineRunAttempt, cause: FailureCause | null, outcome: string): string {
  return [a.jobType, a.status, cause ?? "", outcome, deviceLabel(a), detailOf(a, cause) ?? ""].join(
    "\0",
  );
}

function verbFor(position: number, repeats: number): string {
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
    const sig = signature(a, cause, outcome);
    const previous = entries[entries.length - 1];

    if (previous && sig === lastSignature) {
      previous.repeats += 1;
      previous.positions.push(position);
      previous.verb = "Retried";
      previous.at = a.finishedAt ?? a.startedAt ?? a.queuedAt ?? previous.at;
      previous.open = OPEN_STATUSES.has(a.status);
      return;
    }

    lastSignature = sig;
    entries.push({
      key: a.jobId,
      verb: verbFor(position, 1),
      object: a.jobType,
      outcome,
      cause,
      action: cause ? failureReasonAction(cause) : null,
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
