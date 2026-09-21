import type { SemanticTone } from "@/design/status";
import {
  failureReasonLabel,
  HEARTBEAT_REAP_MS,
  STALLED_THRESHOLD_MS,
  TERMINAL_SESSION_STATUSES,
} from "@/features/sessions/types";
import { formatElapsed } from "@/lib/utils/format";
import type { RunSessionRow } from "./types";

/** `incarnation × work`, which is what the ledger actually stores. */
export type RunState =
  | "live-runnable"
  | "live-blocked"
  | "exited-blocked"
  | "exited-runnable"
  | "closed"
  | "unknown";

export interface StateLabel {
  /** What the row says. Written for someone deciding whether to act. */
  label: string;
  /** One line saying what is true, not what the columns are called. */
  detail: string;
  tone: SemanticTone;
}

export function runState(row: {
  incarnation: string;
  work: string;
}): RunState {
  if (row.work === "done") return "closed";
  const live = row.incarnation === "live" || row.incarnation === "starting";
  if (live && row.work === "runnable") return "live-runnable";
  if (live && row.work === "blocked") return "live-blocked";
  if (row.incarnation === "exited" && row.work === "blocked") return "exited-blocked";
  if (row.incarnation === "exited" && row.work === "runnable") return "exited-runnable";
  return "unknown";
}

const LABELS: Record<RunState, StateLabel> = {
  "live-runnable": {
    label: "Working",
    detail: "An agent is running in this worktree.",
    tone: "active",
  },
  "live-blocked": {
    label: "Blocked, holding the box",
    detail: "Waiting on a machine or another agent, and keeping its process while it waits.",
    tone: "attention",
  },
  "exited-blocked": {
    label: "Parked for a person",
    detail: "The process is gone. The worktree and the branch are kept until someone answers.",
    tone: "blocked",
  },
  "exited-runnable": {
    label: "Answered, awaiting revival",
    detail: "The answer is on the record and nothing has restarted this run yet.",
    tone: "failure",
  },
  closed: {
    label: "Closed",
    detail: "The close loop finished.",
    tone: "archived",
  },
  unknown: {
    label: "Unknown",
    detail: "The box reported a combination this build does not name — nothing may be reclaimed.",
    tone: "infra",
  },
};

export const stateLabel = (s: RunState): StateLabel => LABELS[s];

/** The three close-loop marks, as three. */
export interface CloseMarks {
  sessionTerminal: boolean;
  worktreeGone: boolean;
  /** `null` when the run carries no issues, so "all returned" is not claimed of nothing. */
  leasesReturned: { returned: number; total: number } | null;
}

export function closeMarks(row: Pick<RunSessionRow, "sessionTerminalAt" | "worktreeGoneAt" | "issues">): CloseMarks {
  const issues = row.issues ?? [];
  return {
    sessionTerminal: row.sessionTerminalAt != null,
    worktreeGone: row.worktreeGoneAt != null,
    leasesReturned: issues.length === 0
      ? null
      : { returned: issues.filter((i) => i.leaseReturned).length, total: issues.length },
  };
}

const BLOCKER_TEXT: Record<string, string> = {
  machine: "a machine",
  master_or_peer: "another agent",
  human: "a person",
  nobody: "nobody — this run is a failure with a name",
};

/** Who can end this wait, in words rather than in the wire value. */
export const blockerText = (kind: string | null): string | null =>
  kind == null ? null : (BLOCKER_TEXT[kind] ?? kind);



/** What core's heartbeat says about a run, independently of what the box claims. */
export type PulseState = "beating" | "silent" | "past-threshold" | "unheard";

export interface Pulse {
  state: PulseState;
  /** Milliseconds since the last heartbeat core received, or `null` when it received none. */
  sinceMs: number | null;
}

export function pulse(
  row: Pick<RunSessionRow, "lastActivityAt">,
  nowMs: number,
): Pulse {
  if (!row.lastActivityAt) return { state: "unheard", sinceMs: null };
  const beat = Date.parse(row.lastActivityAt);
  if (Number.isNaN(beat)) return { state: "unheard", sinceMs: null };
  const sinceMs = Math.max(0, nowMs - beat);
  if (sinceMs <= STALLED_THRESHOLD_MS) return { state: "beating", sinceMs };
  if (sinceMs <= HEARTBEAT_REAP_MS) return { state: "silent", sinceMs };
  return { state: "past-threshold", sinceMs };
}

/** Whether this run is one a reader should stop trusting the "working" chip on. */
export function pulseIsStalling(p: Pulse): boolean {
  return p.state === "silent" || p.state === "past-threshold";
}

export function pulseText(p: Pulse): string | null {
  if (p.state === "beating" || p.state === "unheard" || p.sinceMs == null) return null;
  const since = formatElapsed(p.sinceMs);
  return p.state === "silent"
    ? `no report for ${since}`
    : `past the automatic-recovery threshold · no report for ${since}`;
}

/** Whether the box claims a process exists for this run. */
const boxClaimsAProcess = (incarnation: string): boolean =>
  incarnation === "live" || incarnation === "starting";

/**
 * The silence line, on the rows where silence means something.
 */
export function silenceText(
  row: Pick<RunSessionRow, "incarnation" | "lastActivityAt">,
  nowMs: number,
): string | null {
  return boxClaimsAProcess(row.incarnation) ? pulseText(pulse(row, nowMs)) : null;
}

/** The two readings of one run disagreeing, which is the signal rather than an error. */
export type Disagreement = "box-live-core-terminal" | "box-exited-core-running";

export function disagreement(
  row: Pick<RunSessionRow, "incarnation" | "sessionStatus" | "sessionId">,
): Disagreement | null {
  if (!row.sessionId || !row.sessionStatus) return null;
  if (boxClaimsAProcess(row.incarnation) && TERMINAL_SESSION_STATUSES.has(row.sessionStatus)) {
    return "box-live-core-terminal";
  }
  if (row.incarnation === "exited" && row.sessionStatus === "running") {
    return "box-exited-core-running";
  }
  return null;
}

const DISAGREEMENT_TEXT: Record<Disagreement, string> = {
  "box-live-core-terminal": "the box says this is live · core says the session ended",
  "box-exited-core-running": "the box says the process is gone · core still has the session running",
};

export const disagreementText = (d: Disagreement): string => DISAGREEMENT_TEXT[d];

/** Why core failed this run's session, in words, or `null` where core holds no reason. */
export function endReasonText(
  row: Pick<RunSessionRow, "sessionFailureReason" | "sessionStatus">,
): string | null {
  if (!row.sessionStatus || !TERMINAL_SESSION_STATUSES.has(row.sessionStatus)) return null;
  return row.sessionFailureReason ? failureReasonLabel(row.sessionFailureReason) : null;
}

/** The reason core holds on a session it has NOT ended, worded as the note it is. */
export function pendingReasonText(
  row: Pick<RunSessionRow, "sessionFailureReason" | "sessionStatus">,
): string | null {
  if (!row.sessionStatus || TERMINAL_SESSION_STATUSES.has(row.sessionStatus)) return null;
  if (!row.sessionFailureReason) return null;
  return `core's note on this session: ${failureReasonLabel(row.sessionFailureReason)}`;
}
