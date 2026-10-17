// ISS-1228 round 10 — a run row's chip. Where the box claims a process the row says what the run's
// session is doing in the word every screen uses, and once core has heard nothing past the silence
// line, what it last reported; a run with no process keeps the run's own words.

import { describe, expect, it } from "vitest";
import { closeMarks, disagreementText, offlineText, pulseText, runLeaseDisagreementText, stateLabelAt } from "./run-state";

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

  it("keeps the box's holding words for a blocked run core has ended but still hears of", () => {
    expect(stateLabelAt(row({ work: "blocked", sessionStatus: "failed" }), NOW).label).toBe(
      "Blocked, holding the box",
    );
  });
});

describe("pulseText", () => {
  it("says core is ending a run as failed once its silence passes core's limit, never that it recovers", () => {
    const text = pulseText({ state: "past-threshold", sinceMs: 11 * 60_000 });
    expect(text).toContain("core is ending it as failed");
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
      "the box said this was live 52m ago and is offline now · core says the session ended",
    );
    expect(disagreementText("box-live-core-terminal", { observedAt, deviceStatus: "online" })).toBe(
      "the box says this is live · core says the session ended",
    );
    const live = { incarnation: "live", observedAt, sessionId: "s1", sessionStatus: "running" };
    expect(offlineText({ ...live, deviceStatus: "offline" })).toBe("the box is offline · it last reported 52m ago");
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
