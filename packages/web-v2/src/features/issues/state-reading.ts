import { workStateOf } from "@forge/contracts/work-state";
import type { StatusKey } from "@/design/status";
import { formatElapsed } from "@/lib/utils/format";
import { runStatusChip, statusLabel, statusToChip } from "./derive";
import type { IssueFailureInfo, IssueRow } from "./types";
import { deriveQueuedStep, hasLiveAgentSession, inStatusFor, STALE_AFTER_MS } from "./waiting";

/** One half of what the run is doing: the word, the step it is on, and what the word stands for. */
export interface RunPart {
  word: string;
  /** The pipeline step the run or the queued job belongs to, when the row names one. */
  step: string | null;
  /** The sentence behind the word where there is one: a failure's reason, a gate's detail. */
  detail: string | null;
}

/** The one elapsed figure on a row, and what it measures — which differs by row, so it says. */
export interface ElapsedReading {
  label: string;
  stale: boolean;
  title: string;
}

/** What the Issues list's single state signal says for one row. */
export interface StateReading {
  /** Colours the dot; the words beside it always say the same thing, so colour is never the only signal. */
  tone: StatusKey;
  /** An agent is working the issue right now. */
  live: boolean;
  /** The issue's own status, written out. */
  statusWord: string;
  /** A question has waited on a person, and for how long; null where it leaves the state alone. */
  waitingOnPerson: { age: string } | null;
  runs: RunPart[];
  elapsed: ElapsedReading | null;
}

const IN_STATUS_MEASURES = "Counted from when it entered this status; an edit, a merge mark or a claim does not reset it.";

const asTime = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
};

/** ISS-700 — step · reason · time label for a failed run. Calm text when no failure data reached the row. */
export function failureDetailOf(info: IssueFailureInfo | null | undefined, now: number): string {
  if (!info) return "No failure details available";
  const step = info.failedStep.charAt(0).toUpperCase() + info.failedStep.slice(1);
  const failedAt = asTime(info.failedAt);
  const when = failedAt === null ? "" : `${formatElapsed(now - failedAt)} ago`;
  const reason = info.failureReason?.trim();
  const short = reason && reason.length > 140 ? `${reason.slice(0, 139)}…` : reason;
  return [`${step} failed`, short, when].filter(Boolean).join(" · ");
}

function elapsedSince(
  at: number | null,
  now: number,
  title: (label: string) => string,
): ElapsedReading | null {
  if (at === null) return null;
  const ms = Math.max(0, now - at);
  const label = formatElapsed(ms);
  return { label, stale: ms >= STALE_AFTER_MS, title: title(label) };
}

/** When the session the pipeline calls active began, read off the sessions the row carries. */
function activeSessionStart(row: IssueRow): number | null {
  const id = row.pipelineHealth?.activeSession?.id;
  const session = row.agentSessions?.find((s) => s.id === id) ?? row.agentSessions?.[0];
  return asTime(session?.startedAt ?? session?.createdAt);
}

function runParts(row: IssueRow, now: number): RunPart[] {
  const health = row.pipelineHealth;
  const parts: RunPart[] = [];
  const queued = deriveQueuedStep(health, hasLiveAgentSession(row.agentStatus));
  if (row.agentStatus === "running") {
    parts.push({ word: "Running", step: health?.activeSession?.skill ?? null, detail: null });
  } else if (row.agentStatus === "queued") {
    parts.push({ word: "Queued", step: health?.activeSession?.skill ?? null, detail: null });
  }
  if (queued) {
    parts.push({
      word: queued.gate?.short ?? "Queued",
      step: queued.jobType,
      detail: queued.gate ? `${queued.jobType} · ${queued.gate.detail}` : null,
    });
  }
  if (row.agentStatus === "failed") {
    parts.push({
      word: "Failed",
      step: row.failureInfo?.failedStep ?? null,
      detail: failureDetailOf(row.failureInfo, now),
    });
  }
  return parts;
}

/**
 * The tone of the dot, in the order a person scans for: something broke, a person is owed, an
 * agent is at work, then the issue's own status. A queued step is amber only where its gate needs a
 * person to act on it, as its chip always was.
 */
function toneOf(row: IssueRow, waiting: boolean): StatusKey {
  const run = runStatusChip(row);
  if (row.agentStatus === "failed") return "failed";
  if (waiting) return "waiting";
  if (run === "running") return "running";
  if (run === "queued") {
    const gate = deriveQueuedStep(row.pipelineHealth, hasLiveAgentSession(row.agentStatus))?.gate;
    return gate?.needsAction ? "waiting" : "queued";
  }
  return statusToChip(row.status);
}

/**
 * How long the row has been where it is, from the most specific time the row records: a question's
 * wait, a failure, a run, a queued step, and otherwise how long the issue has stood at its status.
 */
function elapsedOf(
  row: IssueRow,
  now: number,
  waiting: { age: string; since: number } | null,
): ElapsedReading | null {
  if (waiting) {
    return {
      label: waiting.age,
      stale: now - waiting.since >= STALE_AFTER_MS,
      title: `A question on this issue has waited on a person for ${waiting.age}. Answer it on the issue.`,
    };
  }
  if (row.agentStatus === "failed") {
    const failed = elapsedSince(asTime(row.failureInfo?.failedAt), now, (l) => `The last run failed ${l} ago.`);
    if (failed) return failed;
  }
  if (row.agentStatus === "running" || row.agentStatus === "queued") {
    const began = elapsedSince(activeSessionStart(row), now, (l) => `This run began ${l} ago.`);
    if (began) return began;
  }
  const queuedStep = row.pipelineHealth?.queuedStep;
  if (queuedStep) {
    const queued = elapsedSince(asTime(queuedStep.queuedAt), now, (l) => `The next step has been queued for ${l}.`);
    if (queued) return queued;
  }
  const held = inStatusFor(row, now);
  if (!held) return null;
  return {
    label: held.label,
    stale: held.stale,
    title: `This issue has been ${statusLabel(row.status)} for ${held.label}. ${IN_STATUS_MEASURES}`,
  };
}

/** The list's state signal for one row, read against one clock the whole page shares. */
export function stateReading(row: IssueRow, now: number): StateReading {
  const since = asTime(row.waitingOnPersonSince);
  // A question on a draft, on finished work or at the release gate leaves the state alone.
  const owed = since !== null && workStateOf(row.status, true) === "blocked_on_person";
  const waitingAge = owed && since !== null ? { age: formatElapsed(now - since), since } : null;
  return {
    tone: toneOf(row, owed),
    live: row.agentStatus === "running",
    statusWord: statusLabel(row.status),
    waitingOnPerson: waitingAge ? { age: waitingAge.age } : null,
    runs: runParts(row, now),
    elapsed: elapsedOf(row, now, waitingAge),
  };
}
