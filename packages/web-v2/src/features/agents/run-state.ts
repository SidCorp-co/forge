import { lastReported, SILENCE_WORD, type SemanticTone, WORKING_WORD } from "@/design/status";
import { leaseDisagreementText } from "@/features/sessions/lease-words";
import { liveSessionWord } from "@/features/sessions/session-word";
import {
  ENDING_AS_FAILED,
  failureReasonLabel,
  sessionSilence,
  TERMINAL_SESSION_STATUSES,
} from "@/features/sessions/types";
import { formatElapsed, formatRelativeTime } from "@/lib/utils/format";
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
    label: WORKING_WORD,
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


/** The three close-loop marks, as three. */
export interface CloseMarks {
  sessionTerminal: boolean;
  worktreeGone: boolean;
  /** `null` when the run carries no issues, so "all returned" is not claimed of nothing. A lease
   *  counts as returned only where the box says so and core no longer holds it. */
  leasesReturned: { returned: number; total: number } | null;
}

/** The issues the box calls returned whose lease core still holds: core refuses another run on them. */
export const leasesCoreStillHolds = (row: Pick<RunSessionRow, "issues">): string[] =>
  (row.issues ?? []).filter((i) => i.leaseReturned && i.coreHolds === true).map((i) => i.issueKey);

export function closeMarks(row: Pick<RunSessionRow, "sessionTerminalAt" | "worktreeGoneAt" | "issues">): CloseMarks {
  const issues = row.issues ?? [];
  return {
    sessionTerminal: row.sessionTerminalAt != null,
    worktreeGone: row.worktreeGoneAt != null,
    leasesReturned: issues.length === 0
      ? null
      : {
          returned: issues.filter((i) => i.leaseReturned && i.coreHolds !== true).length,
          total: issues.length,
        },
  };
}

/** The box and core disagreeing about a lease, which is the one a second run is refused on, in the
 *  words every surface showing the hold uses. */
export const runLeaseDisagreementText = (row: Pick<RunSessionRow, "issues">): string | null =>
  leaseDisagreementText(leasesCoreStillHolds(row));

/** Core reads the box as offline, so nothing it last said is true now. */
export const boxOffline = (row: Pick<RunSessionRow, "deviceStatus">): boolean =>
  row.deviceStatus != null && row.deviceStatus !== "online";

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
  row: Pick<RunSessionRow, "lastActivityAt" | "silenceLimitMs">,
  nowMs: number,
): Pulse {
  if (!row.lastActivityAt || Number.isNaN(Date.parse(row.lastActivityAt))) {
    return { state: "unheard", sinceMs: null };
  }
  const silence = sessionSilence(
    { status: "running", lastHeartbeatAt: row.lastActivityAt, startedAt: null, silenceLimitMs: row.silenceLimitMs },
    nowMs,
  );
  const sinceMs = Math.max(0, silence.sinceHeartbeatMs ?? 0);
  if (silence.state === "stale") return { state: "silent", sinceMs };
  if (silence.state === "reaping") return { state: "past-threshold", sinceMs };
  return { state: "beating", sinceMs };
}

/** Whether this run is one a reader should stop trusting the "working" chip on. */
export function pulseIsStalling(p: Pulse): boolean {
  return p.state === "silent" || p.state === "past-threshold";
}

export function pulseText(p: Pulse): string | null {
  if (p.state === "beating" || p.state === "unheard" || p.sinceMs == null) return null;
  const since = formatElapsed(p.sinceMs);
  return p.state === "silent"
    ? `${SILENCE_WORD} · no report for ${since}`
    : `${SILENCE_WORD} · ${ENDING_AS_FAILED} · no report for ${since}`;
}

const QUIET_DETAIL =
  "The box last reported this, and core has heard nothing from the run's session since.";
const OFFLINE_DETAIL = "The box is offline: this is what it last reported, not what it is doing.";

/**
 * The chip a run's row shows at `nowMs`. Where the box claims a process, the row says what its
 * session is doing in the one word every screen uses (`liveSessionWord`), and once core has heard
 * nothing past the silence line, what it last reported — never that it is working or blocked now.
 * A run with no process keeps its own words: parked, answered, closed.
 */
export function stateLabelAt(
  row: Pick<
    RunSessionRow,
    "incarnation" | "work" | "lastActivityAt" | "silenceLimitMs" | "sessionStatus" | "sessionRuntimeState"
  > &
    Partial<Pick<RunSessionRow, "deviceStatus">>,
  nowMs: number,
): StateLabel {
  const state = runState(row);
  const meta = LABELS[state];
  if (state !== "live-runnable" && state !== "live-blocked") return meta;
  const coreLive = row.sessionStatus != null && !TERMINAL_SESSION_STATUSES.has(row.sessionStatus);
  const word = liveSessionWord(
    {
      status: coreLive ? (row.sessionStatus as string) : "running",
      runtimeState: coreLive ? (row.sessionRuntimeState ?? null) : null,
      report: { work: row.work },
      lastHeartbeatAt: row.lastActivityAt,
      startedAt: null,
      silenceLimitMs: row.silenceLimitMs ?? null,
    },
    nowMs,
  );
  if (word.quiet) return { label: word.label, detail: QUIET_DETAIL, tone: word.tone };
  if (boxOffline(row)) {
    return { label: lastReported(word.activity), detail: OFFLINE_DETAIL, tone: "neutral" };
  }
  return coreLive ? { label: word.label, detail: meta.detail, tone: word.tone } : meta;
}

/** Whether the box claims a process exists for this run. */
const boxClaimsAProcess = (incarnation: string): boolean =>
  incarnation === "live" || incarnation === "starting";

/**
 * The silence line, on the rows where silence means something.
 */
export function silenceText(
  row: Pick<RunSessionRow, "incarnation" | "lastActivityAt" | "silenceLimitMs">,
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

/** What an offline box last said is quoted with when it said it, never in the present tense. */
const OFFLINE_DISAGREEMENT_TEXT: Record<Disagreement, (when: string) => string> = {
  "box-live-core-terminal": (when) =>
    `the box said this was live ${when} and is offline now · core says the session ended`,
  "box-exited-core-running": (when) =>
    `the box said the process was gone ${when} and is offline now · core still has the session running`,
};

export function disagreementText(
  d: Disagreement,
  row: Pick<RunSessionRow, "observedAt"> & Partial<Pick<RunSessionRow, "deviceStatus">>,
): string {
  return boxOffline(row) ? OFFLINE_DISAGREEMENT_TEXT[d](formatRelativeTime(row.observedAt)) : DISAGREEMENT_TEXT[d];
}

/** An offline box claiming a process, where nothing else on the row already says the box is offline. */
export function offlineText(
  row: Pick<RunSessionRow, "incarnation" | "observedAt" | "sessionId" | "sessionStatus"> &
    Partial<Pick<RunSessionRow, "deviceStatus">>,
): string | null {
  if (!boxOffline(row) || !boxClaimsAProcess(row.incarnation) || disagreement(row)) return null;
  return `the box is offline · it last reported ${formatRelativeTime(row.observedAt)}`;
}

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
