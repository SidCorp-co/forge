// ISS-1228 round 10 — a run row's chip. Where the box claims a process the row says what the run's
// session is doing in the word every screen uses, and once core has heard nothing past the silence
// line, what it last reported; a run with no process keeps the run's own words.

import { describe, expect, it } from "vitest";
import { pulseText, stateLabelAt } from "./run-state";

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
