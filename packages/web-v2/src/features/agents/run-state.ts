import { BLOCKED_WORD, lastReported, type SemanticTone, STOPPED_WORD, WORKING_WORD } from "@/design/status";
import {
  blockedHoldingText,
  boxOfflineText,
  coreNoteText,
  leaseDisagreementText,
  offlineSessionDisagreementText,
  parkedText,
  quietForText,
  RUN_DETAIL,
  type SessionDisagreement,
  sessionDisagreementText,
} from "@/features/sessions/status-sentences";
import { liveSessionWord } from "@/features/sessions/session-word";
import {
  failureReasonLabel,
  sessionEndText,
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

/** A run's own words, by its state and, for a blocked one, by who holds its wait: the chip's hover
 *  names the holder the row's wait line names, never a fixed one (ISS-1228). */
function labelOf(state: RunState, blockerKind: string | null | undefined): StateLabel {
  switch (state) {
    case "live-runnable":
      return { label: WORKING_WORD, detail: RUN_DETAIL.working, tone: "active" };
    case "live-blocked":
      return { label: "Blocked, holding the box", detail: blockedHoldingText(blockerKind), tone: "attention" };
    case "exited-blocked":
      return {
        label: blockerKind === "human" ? "Parked for a person" : "Parked",
        detail: parkedText(blockerKind),
        tone: "blocked",
      };
    case "exited-runnable":
      return { label: "Answered, awaiting revival", detail: RUN_DETAIL.answered, tone: "failure" };
    case "closed":
      return { label: "Closed", detail: RUN_DETAIL.closed, tone: "archived" };
    default:
      return { label: "Unknown", detail: RUN_DETAIL.unknown, tone: "infra" };
  }
}


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
  return quietForText(since, p.state !== "silent");
}

/** Core has ended the run's session, whatever the box still says of its process. */
const coreEnded = (row: Pick<RunSessionRow, "sessionStatus">): boolean =>
  row.sessionStatus != null && TERMINAL_SESSION_STATUSES.has(row.sessionStatus);

/**
 * The chip a run's row shows at `nowMs`. Where the box claims a process, the row says what its
 * session is doing in the one word every screen uses (`liveSessionWord`), and once core has heard
 * nothing past the silence line, what it last reported — never that it is working or blocked now.
 * A run with no process keeps its own words: parked, answered, closed.
 */
export function stateLabelAt(
  row: Pick<
    RunSessionRow,
    | "incarnation"
    | "work"
    | "lastActivityAt"
    | "silenceLimitMs"
    | "sessionStatus"
    | "sessionRuntimeState"
    | "observedAt"
  > &
    Partial<Pick<RunSessionRow, "deviceStatus" | "sessionFailureReason" | "blockerKind">>,
  nowMs: number,
): StateLabel {
  const state = runState(row);
  const meta = labelOf(state, row.blockerKind);
  // A person's stop keeps the one word every surface says it with, whatever the box says of its
  // process; the disagreement line beside the chip says what the box reports.
  if (state !== "closed" && coreEnded(row) && row.sessionFailureReason === "user_cancelled") {
    return { label: STOPPED_WORD, detail: RUN_DETAIL.ended, tone: "neutral" };
  }
  if (state !== "live-runnable" && state !== "live-blocked") return meta;
  // An ended session is neither quiet nor doing anything: core no longer takes its check-ins.
  if (coreEnded(row)) {
    return { label: lastReported(row.work === "blocked" ? BLOCKED_WORD : WORKING_WORD), detail: RUN_DETAIL.ended, tone: "neutral" };
  }
  const coreLive = row.sessionStatus != null;
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
  if (word.quiet) return { label: word.label, detail: RUN_DETAIL.quiet, tone: word.tone };
  if (boxOffline(row)) {
    return { label: lastReported(word.activity), detail: boxOfflineText(formatRelativeTime(row.observedAt)), tone: "neutral" };
  }
  return coreLive ? { label: word.label, detail: meta.detail, tone: word.tone } : meta;
}

/** Whether the run waits on someone now: whatever the box reports blocked waits, a holder it did not
 *  name included, and only while core holds the session, so a run core ended waits on nobody (ISS-1228). */
export function waitsNow(row: Pick<RunSessionRow, "work" | "sessionStatus">): boolean {
  return row.work === "blocked" && !coreEnded(row);
}

/** Whether the box claims a process exists for this run. */
const boxClaimsAProcess = (incarnation: string): boolean =>
  incarnation === "live" || incarnation === "starting";

/**
 * The silence line, on the rows where silence means something: a process the box claims, under a
 * session core has not ended. Core takes no check-in from an ended session, so its silence is no news.
 */
export function silenceText(
  row: Pick<RunSessionRow, "incarnation" | "lastActivityAt" | "silenceLimitMs"> &
    Partial<Pick<RunSessionRow, "sessionStatus">>,
  nowMs: number,
): string | null {
  if (!boxClaimsAProcess(row.incarnation) || coreEnded({ sessionStatus: row.sessionStatus ?? null })) return null;
  return pulseText(pulse(row, nowMs));
}

/** The two readings of one run disagreeing, which is the signal rather than an error. */
export type Disagreement = SessionDisagreement;

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

export function disagreementText(
  d: Disagreement,
  row: Pick<RunSessionRow, "observedAt"> & Partial<Pick<RunSessionRow, "deviceStatus">>,
): string {
  return boxOffline(row) ? offlineSessionDisagreementText(d, formatRelativeTime(row.observedAt)) : sessionDisagreementText(d);
}

/** An offline box claiming a process, where nothing else on the row already says the box is offline. */
export function offlineText(
  row: Pick<RunSessionRow, "incarnation" | "observedAt" | "sessionId" | "sessionStatus"> &
    Partial<Pick<RunSessionRow, "deviceStatus">>,
): string | null {
  if (!boxOffline(row) || !boxClaimsAProcess(row.incarnation) || disagreement(row)) return null;
  return boxOfflineText(formatRelativeTime(row.observedAt));
}

export function endReasonText(
  row: Pick<RunSessionRow, "sessionFailureReason" | "sessionStatus">,
): string | null {
  return coreEnded(row) ? sessionEndText(row.sessionFailureReason) : null;
}

/** The reason core holds on a session it has NOT ended, worded as the note it is. */
export function pendingReasonText(
  row: Pick<RunSessionRow, "sessionFailureReason" | "sessionStatus">,
): string | null {
  if (!row.sessionStatus || TERMINAL_SESSION_STATUSES.has(row.sessionStatus)) return null;
  if (!row.sessionFailureReason) return null;
  return coreNoteText(failureReasonLabel(row.sessionFailureReason) ?? row.sessionFailureReason);
}
