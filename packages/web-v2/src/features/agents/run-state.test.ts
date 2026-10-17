// ISS-1228 round 10 — a run row's chip. Where the box claims a process the row says what the run's
// session is doing in the word every screen uses, and once core has heard nothing past the silence
// line, what it last reported; a run with no process keeps the run's own words.

import { describe, expect, it } from "vitest";
import {
  closeMarks,
  disagreementText,
  endReasonText,
  offlineText,
  pulseText,
  runLeaseDisagreementText,
  silenceText,
  stateLabelAt,
} from "./run-state";

const NOW = Date.parse("2026-10-16T10:00:00.000Z");
const HEARD = new Date(NOW - 10_000).toISOString();
const SILENT = new Date(NOW - 90_000).toISOString();

const row = (over: Partial<Parameters<typeof stateLabelAt>[0]> = {}): Parameters<typeof stateLabelAt>[0] => ({
  incarnation: "live",
  work: "runnable",
  lastActivityAt: HEARD,
  silenceLimitMs: 10 * 60_000,
  sessionStatus: "running",
  sessionRuntimeState: "working",
  ...over,
});

describe("stateLabelAt", () => {
  it("says the session's own activity while core holds it running and hears from it", () => {
    expect(stateLabelAt(row({ sessionRuntimeState: "awaiting_input" }), NOW).label).toBe("Waiting for input");
    expect(stateLabelAt(row({ sessionRuntimeState: "checkpointing" }), NOW).label).toBe("Checkpointing");
    expect(stateLabelAt(row({ work: "blocked" }), NOW)).toMatchObject({ label: "Blocked", tone: "attention" });
  });

  it("says what a quiet run last reported, blocked or not, whether core still holds its session or ended it", () => {
    for (const sessionStatus of ["running", "failed", null]) {
      expect(stateLabelAt(row({ work: "blocked", lastActivityAt: SILENT, sessionStatus }), NOW)).toMatchObject({
        label: "Last reported blocked",
        tone: "neutral",
      });
      expect(stateLabelAt(row({ lastActivityAt: SILENT, sessionStatus }), NOW).label).toBe("Last reported working");
    }
  });

  it("keeps the run's own words where the box claims no process", () => {
    expect(stateLabelAt(row({ incarnation: "exited", work: "blocked" }), NOW).label).toBe("Parked for a person");
    expect(stateLabelAt(row({ incarnation: "exited", work: "runnable" }), NOW).label).toBe(
      "Answered, awaiting revival",
    );
    expect(stateLabelAt(row({ work: "done" }), NOW).label).toBe("Closed");
  });

  // ISS-1228 round 13: a run core had ended read in the present tense while its box still reported it.
  it("says what the box last reported of a run whose session core has ended, never that it is doing it", () => {
    expect(stateLabelAt(row({ work: "blocked", sessionStatus: "failed" }), NOW)).toMatchObject({
      label: "Last reported blocked",
      tone: "neutral",
    });
    expect(stateLabelAt(row({ sessionStatus: "failed" }), NOW).label).toBe("Last reported working");
  });

  it("calls a run a person stopped Stopped whatever its box says of its process, until the run closes", () => {
    const stopped = { sessionStatus: "failed", sessionFailureReason: "user_cancelled" };
    for (const [incarnation, work] of [
      ["live", "runnable"],
      ["live", "blocked"],
      ["exited", "blocked"],
      ["exited", "runnable"],
    ]) {
      expect(stateLabelAt(row({ ...stopped, incarnation, work }), NOW).label, `${incarnation} ${work}`).toBe("Stopped");
    }
    expect(stateLabelAt(row({ ...stopped, work: "done" }), NOW).label).toBe("Closed");
  });
});

// ISS-1228 round 13: judge-34 saw an ended run read "Quiet. No report for 19m." beside its box's
// report of two seconds before, and a core-ended session as a bare label.
describe("an ended run's lines", () => {
  const ended = { incarnation: "live", lastActivityAt: new Date(NOW - 19 * 60_000).toISOString(), silenceLimitMs: 10 * 60_000 };

  it("says nothing of silence on a run whose session core has ended", () => {
    expect(silenceText({ ...ended, sessionStatus: "failed" }, NOW)).toBeNull();
    expect(silenceText({ ...ended, sessionStatus: "running" }, NOW)).toMatch(/^Quiet\./);
  });

  it("names the silence a check-in, the clock it reads, never a report", () => {
    expect(silenceText({ ...ended, sessionStatus: "running" }, NOW)).toBe(
      "Quiet. Core is ending it as failed. No check-in for 19m.",
    );
  });

  it("says why the session ended as sentences, a person's stop in its own words", () => {
    expect(endReasonText({ sessionStatus: "failed", sessionFailureReason: "session_stopped_checking_in" })).toBe(
      "The session ended. Stopped checking in.",
    );
    expect(endReasonText({ sessionStatus: "failed", sessionFailureReason: "heartbeat_timeout" })).toBe(
      "The session ended. No heartbeat.",
    );
    expect(endReasonText({ sessionStatus: "failed", sessionFailureReason: "user_cancelled" })).toBe(
      "A person stopped the session.",
    );
    expect(endReasonText({ sessionStatus: "running", sessionFailureReason: "heartbeat_timeout" })).toBeNull();
  });
});

describe("pulseText", () => {
  it("says core is ending a run as failed once its silence passes core's limit, never that it recovers", () => {
    const text = pulseText({ state: "past-threshold", sinceMs: 11 * 60_000 });
    expect(text).toContain("Core is ending it as failed.");
    expect(text).not.toMatch(/recover/i);
  });
});

// ISS-1228 round 11 — a box core reads as offline is quoted in the past, and a lease core still
// holds is not counted returned whatever the box says.
describe("an offline box and a lease core still holds", () => {
  it("says what an offline box last reported, never that the run is working or blocked now", () => {
    expect(stateLabelAt(row({ deviceStatus: "offline" }), NOW)).toMatchObject({
      label: "Last reported working",
      tone: "neutral",
    });
    expect(stateLabelAt(row({ work: "blocked", sessionStatus: "failed", deviceStatus: "offline" }), NOW).label).toBe(
      "Last reported blocked",
    );
    expect(stateLabelAt(row({ deviceStatus: "online" }), NOW).label).toBe("Working");
  });

  it("quotes an offline box with when it last reported", () => {
    const observedAt = new Date(Date.now() - 52 * 60_000).toISOString();
    expect(disagreementText("box-live-core-terminal", { observedAt, deviceStatus: "offline" })).toBe(
      "The box said this was live 52m ago and is offline now. Core says the session ended.",
    );
    expect(disagreementText("box-live-core-terminal", { observedAt, deviceStatus: "online" })).toBe(
      "The box says this is live. Core says the session ended.",
    );
    const live = { incarnation: "live", observedAt, sessionId: "s1", sessionStatus: "running" };
    expect(offlineText({ ...live, deviceStatus: "offline" })).toBe("The box is offline. It last reported 52m ago.");
    expect(offlineText({ ...live, deviceStatus: "online" })).toBeNull();
    expect(offlineText({ ...live, sessionStatus: "failed", deviceStatus: "offline" })).toBeNull();
  });

  it("counts a lease returned only where core no longer holds it, and names the ones it does", () => {
    const issues = [
      { issueKey: "ISS-4", leaseReturned: true, coreHolds: true },
      { issueKey: "ISS-5", leaseReturned: true, coreHolds: false },
    ];
    expect(closeMarks({ sessionTerminalAt: null, worktreeGoneAt: null, issues }).leasesReturned).toEqual({
      returned: 1,
      total: 2,
    });
    expect(runLeaseDisagreementText({ issues })).toBe(
      "The box says it returned ISS-4. Core still holds it. Stop the session to free it.",
    );
    expect(runLeaseDisagreementText({ issues: [issues[1]] })).toBeNull();
  });
});
