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

// cm:guard `exited-runnable` is the state today's UI could not express at all, and it is the one that MUST be visible: it means the question was answered and the run is owed a revival nobody has performed yet. Rendered as "done" or folded into `exited-blocked` it becomes a run that waits for a second answer nobody will send (ISS-964 criteria 38, 51).
// cm:guard derived from the two typed columns and NEVER from a display string. A `status` word collapses the pair — `live × blocked` and `exited × blocked` both read "blocked", and the difference between them is whether a process is still holding the box (ISS-964 criteria 9, 51).
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
    // cm:guard `failure` tone, and it is the loudest on the screen on purpose: this run is not waiting on anybody, it is waiting on the revival nobody performed. A calm tone here is how it stays unnoticed (ISS-964 criteria 38, 51).
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

// cm:guard three fields out, never a rollup boolean: a run whose session reached terminal with its worktree still on disk is a diff somebody can recover, and one where both are done is not. The lease count stays a COUNT because a run over three issues can have returned one (ISS-964 criterion 52).
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

// cm:guard the thresholds are IMPORTED from `features/sessions/types.ts` and are not declared here. `lastActivityAt` on a ledger row is a join onto the very column `deriveLiveness` grades — the same clock on the same object — so a second pair of numbers here would let the Sessions tab and the Runs tab disagree about one session (ISS-998).
// cm:guard `unheard` is its OWN state and is never folded into `silent`: a run that is still `starting` has no session yet, and a session core has never heard from is a different fact from one that has gone quiet. Calling the first silent puts a red mark on every revival in flight.
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

// cm:guard the past-threshold wording names an ELAPSED THRESHOLD and never a sweep that has acted. The client cannot observe the sweeper, `PIPELINE_HEARTBEAT_TIMEOUT_MS` can move the server's bound away from this one, and a scheduler that has not run yet leaves the row saying a recovery happened when none did.
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
// cm:guard a run the box reports EXITED is not graded on its heartbeat, and the omission is the point: a park releases the process on purpose (`ledger.rs` refuses a `Human` blocker any incarnation but `Exited`), so core will never hear from it again and an elapsed-threshold line there is an alarm on correct behaviour. Every parked run on the fleet would carry one (ISS-998).
export function silenceText(
  row: Pick<RunSessionRow, "incarnation" | "lastActivityAt">,
  nowMs: number,
): string | null {
  return boxClaimsAProcess(row.incarnation) ? pulseText(pulse(row, nowMs)) : null;
}

/** The two readings of one run disagreeing, which is the signal rather than an error. */
export type Disagreement = "box-live-core-terminal" | "box-exited-core-running";

// cm:guard both readings are kept and NEITHER is preferred: `readProjectRunSessions` carries `sessionStatus` precisely because the box marking its own homework is not evidence, and a row that quietly picked one of the two would throw away the only cross-check a reader has (ISS-934 criterion 11).
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
// cm:guard routed through the SAME `failureReasonLabel` the Sessions tab uses, so one cause never reads two ways across the two tabs of one screen; an unknown reason resolves rather than falling through as the raw wire word.
// cm:guard the status gate is not optional: `failureReason` is written on a session that is STILL RUNNING for the skip causes — `runner_full`, `issue_busy` — and reading it as an ending puts "why this ended" on a run that is mid-turn. Only a status in `TERMINAL_SESSION_STATUSES` has an ending to name (ISS-998).
export function endReasonText(
  row: Pick<RunSessionRow, "sessionFailureReason" | "sessionStatus">,
): string | null {
  if (!row.sessionStatus || !TERMINAL_SESSION_STATUSES.has(row.sessionStatus)) return null;
  return row.sessionFailureReason ? failureReasonLabel(row.sessionFailureReason) : null;
}

/** The reason core holds on a session it has NOT ended, worded as the note it is. */
// cm:guard the reason is SHOWN and not swallowed — core writes `runner_full` and `issue_busy` on a session that is still running, and those are the answer to "why has this not moved". Gating them out for the sake of the terminal wording would be the silence this whole screen was filed against; the wording is what changes, never whether the reader is told (ISS-998).
export function pendingReasonText(
  row: Pick<RunSessionRow, "sessionFailureReason" | "sessionStatus">,
): string | null {
  if (!row.sessionStatus || TERMINAL_SESSION_STATUSES.has(row.sessionStatus)) return null;
  if (!row.sessionFailureReason) return null;
  return `core's note on this session: ${failureReasonLabel(row.sessionFailureReason)}`;
}
