// ISS-1228 — one word for a live session on every screen. Moved here from the Pipeline's `doingOf`
// (round 10), which the sessions list, the session page and the runs tab did not read, so a session
// Waiting for input on the Pipeline page read Working on the other three.

import { describe, expect, it } from "vitest";
import { isWaitingForInput, liveSessionWord, sessionWord } from "./session-word";

const AT = Date.parse("2026-10-15T10:00:00.000Z");
const HEARD = new Date(AT - 5_000).toISOString();
const SILENT = new Date(AT - 90_000).toISOString();

describe("liveSessionWord — what a session is doing, in words", () => {
  it.each([
    [{ status: "queued", runtimeState: null }, "Waiting for a box"],
    [{ status: "idle", runtimeState: null }, "Not started"],
    [{ status: "running", runtimeState: "starting" }, "Starting"],
    [{ status: "running", runtimeState: "working" }, "Working"],
    [{ status: "running", runtimeState: "awaiting_input" }, "Waiting for input"],
    [{ status: "running", runtimeState: "checkpointing" }, "Checkpointing"],
    [{ status: "running", runtimeState: "closed" }, "Closing"],
    [{ status: "running", runtimeState: null }, "Working"],
  ])("%o reads %s", (s, label) => {
    expect(liveSessionWord({ ...s, lastHeartbeatAt: HEARD, startedAt: HEARD }, AT).label).toBe(label);
  });

  it("lets a queued status outrank a runtime state the box left behind", () => {
    expect(
      liveSessionWord({ status: "queued", runtimeState: "working", lastHeartbeatAt: null, startedAt: null }, AT)
        .label,
    ).toBe("Waiting for a box");
  });

  it("says what a running session silent past a minute last reported, never that it is doing it", () => {
    const silent = { status: "running", lastHeartbeatAt: SILENT, startedAt: SILENT };
    expect(liveSessionWord({ ...silent, runtimeState: "working" }, AT)).toEqual({
      label: "Last reported working",
      tone: "neutral",
      quiet: true,
      activity: "Working",
      icon: "quiet",
    });
    expect(liveSessionWord({ ...silent, runtimeState: "awaiting_input" }, AT).label).toBe(
      "Last reported waiting for input",
    );
    expect(liveSessionWord({ ...silent, runtimeState: null }, AT).label).toBe("Last reported working");
  });

  it("calls a session its box reports blocked Blocked, never Working, and a quiet one Last reported blocked", () => {
    const heard = { status: "running", runtimeState: "working", startedAt: HEARD, report: { work: "blocked" } };
    expect(liveSessionWord({ ...heard, lastHeartbeatAt: HEARD }, AT)).toEqual({
      label: "Blocked",
      tone: "attention",
      quiet: false,
      activity: "Blocked",
      icon: "pause",
    });
    expect(liveSessionWord({ ...heard, lastHeartbeatAt: SILENT }, AT).label).toBe("Last reported blocked");
    expect(liveSessionWord({ ...heard, lastHeartbeatAt: HEARD, report: { work: "runnable" } }, AT).label).toBe(
      "Working",
    );
  });

  it("calls a session heard from exactly a minute ago working, and one a second past that quiet", () => {
    const at = (ms: number) => new Date(AT - ms).toISOString();
    const base = { status: "running", runtimeState: "working" };
    expect(liveSessionWord({ ...base, lastHeartbeatAt: at(60_000), startedAt: null }, AT).label).toBe("Working");
    expect(liveSessionWord({ ...base, lastHeartbeatAt: at(61_000), startedAt: null }, AT).label).toBe(
      "Last reported working",
    );
  });
});

describe("sessionWord — the word, or none where a session has no live word", () => {
  it("names no word for a session that has ended", () => {
    for (const status of ["completed", "failed", "cancelled", "cancelled_stale", "completed_via_recovery"]) {
      expect(sessionWord({ status, lastHeartbeatAt: HEARD, startedAt: HEARD }, AT)).toBeNull();
    }
  });

  it("names no word for a chat, whose idle is a reply awaited rather than a session not started", () => {
    expect(sessionWord({ status: "idle", kind: "chat", lastHeartbeatAt: null, startedAt: null }, AT)).toBeNull();
    expect(
      sessionWord({ status: "idle", metadata: { type: "interactive" }, lastHeartbeatAt: null, startedAt: null }, AT),
    ).toBeNull();
  });

  it("answers a run session, and a row that names no kind at all, with its live word", () => {
    const run = { status: "running", runtimeState: "checkpointing", lastHeartbeatAt: HEARD, startedAt: HEARD };
    expect(sessionWord({ ...run, kind: "run_session" }, AT)?.label).toBe("Checkpointing");
    expect(sessionWord(run, AT)?.label).toBe("Checkpointing");
  });
});

describe("isWaitingForInput — what the Pipeline page calls Waiting for input", () => {
  const base = { status: "running", kind: "pipeline", lastHeartbeatAt: HEARD, startedAt: HEARD };

  it("holds for a heard-from session whose runtime state is awaiting input", () => {
    expect(isWaitingForInput({ ...base, runtimeState: "awaiting_input" }, AT)).toBe(true);
  });

  it("does not hold once it is quiet, blocked, or doing anything else", () => {
    const quiet = { ...base, runtimeState: "awaiting_input", lastHeartbeatAt: SILENT, startedAt: SILENT };
    expect(isWaitingForInput(quiet, AT)).toBe(false);
    expect(isWaitingForInput({ ...base, runtimeState: "awaiting_input", report: { work: "blocked" } }, AT)).toBe(
      false,
    );
    expect(isWaitingForInput({ ...base, runtimeState: "working" }, AT)).toBe(false);
  });
});
