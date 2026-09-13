import { describe, expect, it } from "vitest";
import { HEARTBEAT_REAP_MS, STALLED_THRESHOLD_MS } from "@/features/sessions/types";
import {
  blockerText,
  closeMarks,
  disagreement,
  disagreementText,
  endReasonText,
  pendingReasonText,
  pulse,
  pulseIsStalling,
  pulseText,
  runState,
  silenceText,
  stateLabel,
} from "./run-state";


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


const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("the heartbeat core holds for a run", () => {
  // cm:guard the assertions sit either side of each boundary rather than well clear of it: a test taking a 4-hour-old beat and a 1-second-old one passes against a build with no thresholds at all.
  it("grades a beat either side of the stalled threshold", () => {
    expect(pulse({ lastActivityAt: ago(STALLED_THRESHOLD_MS) }, NOW).state).toBe("beating");
    expect(pulse({ lastActivityAt: ago(STALLED_THRESHOLD_MS + 1) }, NOW).state).toBe("silent");
  });

  it("grades a beat either side of the automatic-recovery threshold", () => {
    expect(pulse({ lastActivityAt: ago(HEARTBEAT_REAP_MS) }, NOW).state).toBe("silent");
    expect(pulse({ lastActivityAt: ago(HEARTBEAT_REAP_MS + 1) }, NOW).state).toBe("past-threshold");
  });

  // cm:guard a run core has never heard from must NOT read as silent: a revival between its CAS and its process registering has no session yet, and calling that stuck marks every start (ISS-998).
  it("keeps a run it has never heard from apart from one that has gone quiet", () => {
    expect(pulse({ lastActivityAt: null }, NOW).state).toBe("unheard");
    expect(pulse({ lastActivityAt: "not a date" }, NOW).state).toBe("unheard");
    expect(pulseIsStalling(pulse({ lastActivityAt: null }, NOW))).toBe(false);
    expect(pulseIsStalling(pulse({ lastActivityAt: ago(HEARTBEAT_REAP_MS + 1) }, NOW))).toBe(true);
  });

  it("says nothing at all while the beat is fresh", () => {
    expect(pulseText(pulse({ lastActivityAt: ago(1_000) }, NOW))).toBeNull();
    expect(pulseText(pulse({ lastActivityAt: null }, NOW))).toBeNull();
  });

  it("names how long the silence has lasted", () => {
    expect(pulseText(pulse({ lastActivityAt: ago(4 * 3_600_000) }, NOW))).toContain("4h");
  });

  // cm:guard the wording is the FALSIFIABLE half of criterion 3: past the threshold the client knows only that the bound elapsed. `PIPELINE_HEARTBEAT_TIMEOUT_MS` can move the server's bound and a scheduler that has not run leaves nothing recovered, so any past tense here is a claim about a server action no browser can observe.
  it("claims an elapsed threshold and never a recovery that happened", () => {
    const text = pulseText(pulse({ lastActivityAt: ago(HEARTBEAT_REAP_MS + 1) }, NOW)) ?? "";
    expect(text).toMatch(/threshold/i);
    expect(text).not.toMatch(/recovered|swept|restarted|has been|was reaped/i);
  });
});

describe("the silence line", () => {
  const row = (incarnation: string, lastActivityAt: string | null) => ({ incarnation, lastActivityAt });

  // cm:guard the falsifying PAIR: a build that dropped the incarnation test entirely passes the first assertion, and one that dropped the line altogether passes the second.
  it("grades a box that claims a process and stays silent about one that does not", () => {
    expect(silenceText(row("live", ago(4 * 3_600_000)), NOW)).toMatch(/no report/);
    expect(silenceText(row("starting", ago(4 * 3_600_000)), NOW)).toMatch(/no report/);
    expect(
      silenceText(row("exited", ago(4 * 3_600_000)), NOW),
      "a park releases the process on purpose, so core will never hear from it again",
    ).toBeNull();
  });

  it("says nothing about a live run that is still reporting", () => {
    expect(silenceText(row("live", ago(1_000)), NOW)).toBeNull();
  });
});

describe("the two readings disagreeing", () => {
  const base = { sessionId: "s-1" };

  it("names a box calling a run live over a session core has ended", () => {
    expect(
      disagreement({ ...base, incarnation: "live", sessionStatus: "failed" }),
    ).toBe("box-live-core-terminal");
    expect(
      disagreement({ ...base, incarnation: "starting", sessionStatus: "cancelled" }),
    ).toBe("box-live-core-terminal");
  });

  it("names a box calling the process gone over a session core still has running", () => {
    expect(
      disagreement({ ...base, incarnation: "exited", sessionStatus: "running" }),
    ).toBe("box-exited-core-running");
  });

  it("is silent when the two agree, and when there is no session to compare", () => {
    expect(disagreement({ ...base, incarnation: "live", sessionStatus: "running" })).toBeNull();
    expect(disagreement({ ...base, incarnation: "exited", sessionStatus: "completed" })).toBeNull();
    expect(
      disagreement({ sessionId: null, incarnation: "live", sessionStatus: "failed" }),
    ).toBeNull();
  });

  it("gives every disagreement words that name both readings", () => {
    for (const d of ["box-live-core-terminal", "box-exited-core-running"] as const) {
      expect(disagreementText(d)).toMatch(/box/);
      expect(disagreementText(d)).toMatch(/core/);
    }
  });
});

describe("why a session ended", () => {
  // cm:guard routed through the Sessions tab's own label table, so one cause never reads two ways across the two tabs of one screen, and an unknown reason resolves rather than leaking the wire word.
  it("says the cause in words rather than the stored reason", () => {
    const text = endReasonText({
      sessionFailureReason: "agent_exited_without_result",
      sessionStatus: "failed",
    });
    expect(text).not.toBe("agent_exited_without_result");
    expect(text ?? "").toMatch(/exited/i);
  });

  it("says nothing where core holds no reason", () => {
    expect(endReasonText({ sessionFailureReason: null, sessionStatus: "failed" })).toBeNull();
  });

  // cm:guard the FALSIFYING pair: `failureReason` is written on a session that is still running for the skip causes, so a version reading the reason alone renders "why this ended" over a run that is mid-turn. Both halves are needed — one reading nothing at all passes the first assertion.
  it("names no ending for a run whose session core still calls running", () => {
    expect(
      endReasonText({ sessionFailureReason: "runner_full", sessionStatus: "running" }),
    ).toBeNull();
    expect(
      endReasonText({ sessionFailureReason: "runner_full", sessionStatus: "failed" }),
    ).not.toBeNull();
  });

  // cm:guard the reason core holds on a session it has NOT ended is still SHOWN, in wording that does not call it an ending: `runner_full` on a running session is the answer to "why has this not moved", and suppressing it to keep the wording tidy is the silence this screen was filed against (ISS-998).
  it("shows a reason core holds on a running session, worded as a note", () => {
    const text = pendingReasonText({
      sessionFailureReason: "runner_full",
      sessionStatus: "running",
    });
    expect(text ?? "").toMatch(/capacity/i);
    expect(text ?? "").not.toMatch(/ended/i);
    expect(
      pendingReasonText({ sessionFailureReason: "runner_full", sessionStatus: "failed" }),
    ).toBeNull();
  });

  it("says nothing at all where core holds no session for this run", () => {
    expect(endReasonText({ sessionFailureReason: "runner_full", sessionStatus: null })).toBeNull();
  });
});
