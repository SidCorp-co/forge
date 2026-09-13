import { pulse, pulseIsStalling, runState } from "./run-state";
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
// cm:guard a `live-runnable` run whose heartbeat has gone quiet joins them, and that is the whole point of the filter's name: the box calls it live and it is doing nothing, which is the shape a pane stopped on a prompt presents as. A run core has never heard from (`unheard`) does NOT join — a revival in flight has no session yet, and marking it stuck puts a warning on every start (ISS-998).
export function inState(row: RunSessionRow, f: StateFilter, nowMs: number): boolean {
  if (f === "all") return true;
  const s = runState(row);
  const waiting =
    s === "live-blocked" ||
    s === "exited-blocked" ||
    s === "exited-runnable" ||
    (s === "live-runnable" && pulseIsStalling(pulse(row, nowMs)));
  return f === "waiting" ? waiting : !waiting;
}

export function applyFilters(
  rows: RunSessionRow[],
  q: string,
  f: StateFilter,
  nowMs: number,
): RunSessionRow[] {
  return rows.filter((r) => inState(r, f, nowMs) && matches(r, q));
}
