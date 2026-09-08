import { describe, expect, it } from "vitest";
import { applyFilters, inState, matches } from "./filter";
import { blockerText, closeMarks, runState, stateLabel } from "./run-state";
import type { RunSessionRow } from "./types";

describe("the four states", () => {
  it("names each combination of the two axes", () => {
    expect(runState({ incarnation: "live", work: "runnable" })).toBe("live-runnable");
    expect(runState({ incarnation: "live", work: "blocked" })).toBe("live-blocked");
    expect(runState({ incarnation: "exited", work: "blocked" })).toBe("exited-blocked");
    expect(runState({ incarnation: "exited", work: "runnable" })).toBe("exited-runnable");
  });

  // cm:guard the state today's UI could not express, and the reason it must be its own row: an answered park is owed a revival nobody has performed, so folding it into either neighbour hides work that is stuck rather than waiting (ISS-964 criteria 38, 51).
  it("distinguishes an answered park from one still waiting", () => {
    const parked = runState({ incarnation: "exited", work: "blocked" });
    const answered = runState({ incarnation: "exited", work: "runnable" });

    expect(parked).not.toBe(answered);
    expect(stateLabel(answered).tone).toBe("failure");
    expect(stateLabel(answered).label).toMatch(/revival/i);
  });

  it("reads `starting` as live, because a process exists", () => {
    expect(runState({ incarnation: "starting", work: "runnable" })).toBe("live-runnable");
  });

  // cm:guard a combination this build does not name renders as `unknown` and NOT as closed or working: criterion 35 permits no reclamation on an unknown, and a screen that guessed would invite exactly that.
  it("refuses to guess at a combination it does not know", () => {
    expect(runState({ incarnation: "teleported", work: "runnable" })).toBe("unknown");
    expect(stateLabel("unknown").detail).toMatch(/nothing may be reclaimed/);
  });

  it("reads work=done as closed whatever the incarnation says", () => {
    expect(runState({ incarnation: "live", work: "done" })).toBe("closed");
    expect(runState({ incarnation: "exited", work: "done" })).toBe("closed");
  });

  it("gives every state a label and a detail", () => {
    for (const s of [
      "live-runnable",
      "live-blocked",
      "exited-blocked",
      "exited-runnable",
      "closed",
      "unknown",
    ] as const) {
      expect(stateLabel(s).label.length, s).toBeGreaterThan(0);
      expect(stateLabel(s).detail.length, s).toBeGreaterThan(0);
    }
  });
});

describe("the three close-loop marks", () => {
  const row = (over: Partial<Parameters<typeof closeMarks>[0]> = {}) => ({
    sessionTerminalAt: null,
    worktreeGoneAt: null,
    issues: [{ issueKey: "ISS-964", leaseReturned: false }],
    ...over,
  });

  it("reports a half-closed run as half-closed", () => {
    const m = closeMarks(
      row({
        sessionTerminalAt: "2026-09-09T10:00:00.000Z",
        issues: [
          { issueKey: "ISS-964", leaseReturned: true },
          { issueKey: "ISS-933", leaseReturned: false },
        ],
      }),
    );

    expect(m.sessionTerminal).toBe(true);
    expect(m.worktreeGone, "the diff is still on disk, and that is the fact a reader acts on").toBe(
      false,
    );
    expect(m.leasesReturned).toEqual({ returned: 1, total: 2 });
  });

  // cm:guard a run carrying NO issues reports `null` rather than 0/0, because "every lease is back" is not a claim to make about a run that never held one.
  it("claims nothing about the leases of a run that holds no issues", () => {
    expect(closeMarks(row({ issues: [] })).leasesReturned).toBeNull();
  });
});

describe("who can end the wait", () => {
  it("says it in words rather than in the wire value", () => {
    expect(blockerText("human")).toMatch(/person/);
    expect(blockerText("master_or_peer")).toMatch(/agent/);
    expect(blockerText("nobody")).toMatch(/failure with a name/);
  });

  it("passes an unknown kind through rather than dropping it", () => {
    expect(blockerText("gremlin")).toBe("gremlin");
    expect(blockerText(null)).toBeNull();
  });
});

describe("the screen's filters", () => {
  const row = (over: Partial<RunSessionRow> = {}): RunSessionRow =>
    ({
      runId: "run-1",
      projectId: "p-1",
      sessionId: null,
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
      lastActivityAt: null,
      masterTitle: null,
      ...over,
    }) as RunSessionRow;

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

  it("counts an answered park as waiting, not as working", () => {
    const answered = row({ incarnation: "exited", work: "runnable" });
    expect(inState(answered, "waiting")).toBe(true);
    expect(inState(answered, "working")).toBe(false);
  });

  it("returns nothing for a search that matches nothing, which is the empty-search state", () => {
    expect(applyFilters([row()], "zzz", "all")).toEqual([]);
  });
});
