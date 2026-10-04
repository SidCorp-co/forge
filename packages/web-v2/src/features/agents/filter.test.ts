import type { RunStanding } from "@forge/contracts/run-standing";
import { describe, expect, it } from "vitest";
import { applyFilters, standingOf } from "./filter";
import type { RunSessionRow } from "./types";

const row = (over: Partial<RunSessionRow> = {}): RunSessionRow => ({
  runId: "box-run-1",
  projectId: "p",
  sessionId: "s-1",
  masterSessionId: null,
  pid: 1,
  worktreePath: "/w",
  bootId: "b",
  incarnation: "live",
  work: "runnable",
  blockerKind: null,
  waitingOn: null,
  sessionTerminalAt: null,
  worktreeGoneAt: null,
  issues: [],
  deviceId: "d",
  deviceName: "box",
  observedAt: "2026-10-04T10:00:00Z",
  sessionStatus: "running",
  sessionFailureReason: null,
  lastActivityAt: "2026-10-04T08:00:00Z",
  masterTitle: null,
  ...over,
});

const standing = (state: RunStanding["state"]): RunStanding =>
  ({ id: "r-1", sessionId: "s-1", state }) as unknown as RunStanding;

describe("the runs pane reads stuck from core, never from the beat it is shown", () => {
  it("a live-runnable run core reads stuck is not progressing", () => {
    const m = new Map([["s-1", standing("stuck")]]);
    expect(applyFilters([row()], "", "waiting", m)).toHaveLength(1);
    expect(applyFilters([row()], "", "working", m)).toHaveLength(0);
  });

  it("an old beat alone does not make a run not progressing: core's running stands", () => {
    const m = new Map([["s-1", standing("running")]]);
    expect(applyFilters([row()], "", "working", m)).toHaveLength(1);
    expect(applyFilters([row()], "", "waiting", m)).toHaveLength(0);
  });

  it("joins a ledger row to core's run on the session core opened for it", () => {
    const m = new Map([["s-1", standing("stuck")]]);
    expect(standingOf(row(), m)?.state).toBe("stuck");
    expect(standingOf(row({ sessionId: null }), m)).toBeNull();
  });
});
