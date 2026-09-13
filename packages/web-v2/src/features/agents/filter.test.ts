// cm:why the filters live in a file of their own since ISS-998: `inState` now takes a clock, because "not progressing" stopped being a property of the two ledger columns alone the moment a run the box calls live but core has not heard from joined it.

import { describe, expect, it } from "vitest";
import { HEARTBEAT_REAP_MS, STALLED_THRESHOLD_MS } from "@/features/sessions/types";
import { applyFilters, inState, matches } from "./filter";
import type { RunSessionRow } from "./types";

const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const row = (over: Partial<RunSessionRow> = {}): RunSessionRow =>
  ({
    runId: "run-1",
    projectId: "p-1",
    sessionId: "s-1",
    masterSessionId: null,
    pid: null,
    worktreePath: "/repo/.worktrees/grp-964",
    bootId: "boot-a",
    incarnation: "live",
    work: "runnable",
    blockerKind: null,
    waitingOn: null,
    sessionTerminalAt: null,
    worktreeGoneAt: null,
    issues: [{ issueKey: "ISS-964", leaseReturned: false }],
    deviceId: "d-1",
    deviceName: "dev1",
    observedAt: "2026-09-09T10:00:00.000Z",
    sessionStatus: "running",
    sessionFailureReason: null,
    lastActivityAt: ago(1_000),
    masterTitle: null,
    ...over,
  }) as RunSessionRow;

describe("the text filter", () => {
  it("matches an issue key, a box name and the worktree", () => {
    expect(matches(row(), "iss-964")).toBe(true);
    expect(matches(row(), "dev1")).toBe(true);
    expect(matches(row(), "grp-964")).toBe(true);
    expect(matches(row(), "nothing-like-this")).toBe(false);
  });

  // cm:guard the two filters must not overlap: a reader typing a state word means the state filter, and matching the label in the text search would make both untrustworthy.
  it("does not match the state label as text", () => {
    expect(matches(row({ incarnation: "exited", work: "blocked" }), "parked")).toBe(false);
  });
});

describe("the state filter", () => {
  it("counts an answered park as waiting, not as working", () => {
    const answered = row({ incarnation: "exited", work: "runnable" });
    expect(inState(answered, "waiting", NOW)).toBe(true);
    expect(inState(answered, "working", NOW)).toBe(false);
  });

  // cm:guard the whole point of the filter's name, and the assertion pairs the two sides: a build that put EVERY live-runnable run under "waiting" would pass the first expectation alone, and one that still read the two ledger columns only would pass the second alone.
  it("counts a live run core has stopped hearing from as not progressing", () => {
    const working = row({ lastActivityAt: ago(1_000) });
    const silent = row({ lastActivityAt: ago(STALLED_THRESHOLD_MS + 1) });
    const long = row({ lastActivityAt: ago(HEARTBEAT_REAP_MS + 1) });

    expect(inState(working, "working", NOW)).toBe(true);
    expect(inState(working, "waiting", NOW)).toBe(false);
    expect(inState(silent, "waiting", NOW)).toBe(true);
    expect(inState(silent, "working", NOW)).toBe(false);
    expect(inState(long, "waiting", NOW)).toBe(true);
  });

  // cm:guard a revival in flight has no session and therefore no beat; grading it stuck would put a warning on every start the fleet makes (ISS-998).
  it("leaves a run it has never heard from under working", () => {
    const starting = row({ incarnation: "starting", sessionId: null, lastActivityAt: null });
    expect(inState(starting, "working", NOW)).toBe(true);
    expect(inState(starting, "waiting", NOW)).toBe(false);
  });

  it("returns nothing for a search that matches nothing, which is the empty-search state", () => {
    expect(applyFilters([row()], "zzz", "all", NOW)).toEqual([]);
  });
});
