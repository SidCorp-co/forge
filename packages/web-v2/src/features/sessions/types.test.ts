import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_REAP_MS,
  STALLED_THRESHOLD_MS,
  deriveLiveness,
  deriveSessionDisplayStatus,
  isInteractiveSession,
  sessionKind,
  type SessionRow,
} from "./types";

const NOW = Date.parse("2026-06-04T12:00:00.000Z");

/** Build a minimal `running` SessionRow whose last heartbeat is `agoMs` old. */
function running(agoMs: number, over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "sess",
    projectId: "proj",
    userId: null,
    deviceId: null,
    pipelineRunId: null,
    title: null,
    repoPath: null,
    status: "running",
    usage: null,
    metadata: { type: "pipeline" },
    failureReason: null,
    dispatchedAt: null,
    startedAt: null,
    lastHeartbeatAt: new Date(NOW - agoMs).toISOString(),
    createdAt: new Date(NOW - agoMs).toISOString(),
    updatedAt: new Date(NOW - agoMs).toISOString(),
    ...over,
  };
}

describe("deriveLiveness", () => {
  it("is alive just under the stale threshold (59s)", () => {
    expect(deriveLiveness(running(59_000), NOW).state).toBe("alive");
  });

  it("is stale just over the stale threshold (61s) with a reap countdown", () => {
    const r = deriveLiveness(running(61_000), NOW);
    expect(r.state).toBe("stale");
    expect(r.reapInMs).toBe(HEARTBEAT_REAP_MS - 61_000);
  });

  it("is still stale just under the reap bound (179s)", () => {
    expect(deriveLiveness(running(179_000), NOW).state).toBe("stale");
  });

  it("is reaping past the reap bound (181s)", () => {
    const r = deriveLiveness(running(181_000), NOW);
    expect(r.state).toBe("reaping");
    expect(r.reapInMs).toBe(0);
  });

  it("treats the exact thresholds as the lower band (boundaries inclusive)", () => {
    expect(deriveLiveness(running(STALLED_THRESHOLD_MS), NOW).state).toBe("alive");
    expect(deriveLiveness(running(HEARTBEAT_REAP_MS), NOW).state).toBe("stale");
  });

  it("returns na for an interactive chat session even when long-running", () => {
    const chat = running(10 * 60_000, { metadata: { type: "interactive" } });
    expect(deriveLiveness(chat, NOW).state).toBe("na");
  });

  it("returns na for non-running sessions", () => {
    expect(deriveLiveness(running(999_000, { status: "completed" }), NOW).state).toBe("na");
    expect(deriveLiveness(running(999_000, { status: "queued" }), NOW).state).toBe("na");
  });

  it("is alive when no heartbeat signal exists at all", () => {
    const r = deriveLiveness(
      running(0, { lastHeartbeatAt: null, startedAt: null, updatedAt: null as unknown as string }),
      NOW,
    );
    expect(r.state).toBe("alive");
  });
});

describe("deriveSessionDisplayStatus (single-sourced on deriveLiveness)", () => {
  it("maps alive → running, stale/reaping → stalled", () => {
    expect(deriveSessionDisplayStatus(running(59_000), NOW)).toBe("running");
    expect(deriveSessionDisplayStatus(running(61_000), NOW)).toBe("stalled");
    expect(deriveSessionDisplayStatus(running(181_000), NOW)).toBe("stalled");
  });

  it("never marks an interactive chat stalled", () => {
    const chat = running(10 * 60_000, { metadata: { type: "interactive" } });
    expect(deriveSessionDisplayStatus(chat, NOW)).toBe("running");
  });

  it("passes through non-running statuses", () => {
    expect(deriveSessionDisplayStatus(running(0, { status: "failed" }), NOW)).toBe("failed");
  });
});

describe("sessionKind / isInteractiveSession", () => {
  it("classifies pipeline + pm as pipeline", () => {
    expect(sessionKind({ metadata: { type: "pipeline" } })).toBe("pipeline");
    expect(sessionKind({ metadata: { type: "pm" } })).toBe("pipeline");
  });

  it("classifies agent / interactive / unset as chat", () => {
    expect(sessionKind({ metadata: { type: "agent" } })).toBe("chat");
    expect(sessionKind({ metadata: { type: "interactive" } })).toBe("chat");
    expect(sessionKind({ metadata: null })).toBe("chat");
    expect(isInteractiveSession({ metadata: { type: "agent" } })).toBe(true);
    expect(isInteractiveSession({ metadata: { type: "pipeline" } })).toBe(false);
  });
});
