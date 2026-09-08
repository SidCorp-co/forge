import type { SemanticTone } from "@/design/status";
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
