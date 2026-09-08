import { runState } from "./run-state";
import type { RunSessionRow } from "./types";

/** Free-text match over the fields a reader would actually type. */
// cm:guard the run id, the issue keys, the branch-shaped worktree tail and the box name — NOT the state label. A reader typing "parked" means the state filter, and matching the label here would make the two filters silently overlap so neither is trustworthy.
export function matches(row: RunSessionRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === "") return true;
  const hay = [
    row.runId,
    row.worktreePath,
    row.deviceName ?? "",
    row.masterTitle ?? "",
    ...(row.issues ?? []).map((i) => i.issueKey),
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(needle);
}

export type StateFilter = "all" | "waiting" | "working";

// cm:guard `waiting` groups the two blocked states and `exited-runnable` with them, because all three are runs that are NOT progressing — an answered park nobody revived is the most stuck of the three and hiding it under "working" is how it goes unnoticed (ISS-964 criterion 51).
export function inState(row: RunSessionRow, f: StateFilter): boolean {
  if (f === "all") return true;
  const s = runState(row);
  const waiting = s === "live-blocked" || s === "exited-blocked" || s === "exited-runnable";
  return f === "waiting" ? waiting : !waiting;
}

export function applyFilters(
  rows: RunSessionRow[],
  q: string,
  f: StateFilter,
): RunSessionRow[] {
  return rows.filter((r) => inState(r, f) && matches(r, q));
}
