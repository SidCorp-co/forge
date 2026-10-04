import type { RunStanding } from "@forge/contracts/run-standing";
import { runState } from "./run-state";
import type { RunSessionRow } from "./types";

/** Free-text match over the fields a reader would actually type. */
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

export type StandingBySession = ReadonlyMap<string, RunStanding>;

export function standingOf(row: RunSessionRow, standings: StandingBySession): RunStanding | null {
  return row.sessionId ? (standings.get(row.sessionId) ?? null) : null;
}

export function inState(row: RunSessionRow, f: StateFilter, standings: StandingBySession): boolean {
  if (f === "all") return true;
  const s = runState(row);
  const waiting =
    s === "live-blocked" ||
    s === "exited-blocked" ||
    s === "exited-runnable" ||
    standingOf(row, standings)?.state === "stuck";
  return f === "waiting" ? waiting : !waiting;
}

export function applyFilters(
  rows: RunSessionRow[],
  q: string,
  f: StateFilter,
  standings: StandingBySession,
): RunSessionRow[] {
  return rows.filter((r) => inState(r, f, standings) && matches(r, q));
}
