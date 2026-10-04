import type { LegendTone } from "@/design/vocabulary";
import { failureReasonLabel, TERMINAL_SESSION_STATUSES } from "@/features/sessions/types";
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
  tone: LegendTone;
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
    tone: "run",
  },
  "live-blocked": {
    label: "Blocked, holding the box",
    detail: "Waiting on a machine or another agent, and keeping its process while it waits.",
    tone: "blocked",
  },
  "exited-blocked": {
    label: "Parked for a person",
    detail: "The process is gone. The worktree and the branch are kept until someone answers.",
    tone: "you",
  },
  "exited-runnable": {
    label: "Answered, awaiting revival",
    detail: "The answer is on the record and nothing has restarted this run yet.",
    tone: "err",
  },
  closed: {
    label: "Closed",
    detail: "The close loop finished.",
    tone: "done",
  },
  unknown: {
    label: "Unknown",
    detail: "The box reported a combination this build does not name — nothing may be reclaimed.",
    tone: "blocked",
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
