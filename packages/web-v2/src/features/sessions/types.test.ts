import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_REAP_MS,
  STALLED_THRESHOLD_MS,
  deriveLiveness,
  deriveSessionDisplayStatus,
  isInteractiveSession,
  sessionKind,
  statusToChip,
  classifySessionOutcome,
  isRealFailure,
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

describe("statusToChip (ISS-322 — cancelled_stale is neutral, not red)", () => {
  it("maps cancelled_stale → swept (neutral), NOT zombie (red)", () => {
    expect(statusToChip("cancelled_stale")).toBe("swept");
  });

  it("keeps a LIVE stalled session as zombie (attention)", () => {
    expect(statusToChip("stalled")).toBe("zombie");
  });

  it("keeps genuine + success states unchanged", () => {
    expect(statusToChip("failed")).toBe("failed");
    expect(statusToChip("completed")).toBe("done");
    expect(statusToChip("completed_via_recovery")).toBe("done");
    expect(statusToChip("running")).toBe("running");
  });
});

describe("classifySessionOutcome (ISS-322 four-bucket classifier)", () => {
  it("classifies clean completions as success/done", () => {
    expect(classifySessionOutcome("completed").bucket).toBe("success");
    expect(classifySessionOutcome("completed_via_recovery").statusKey).toBe("done");
  });

  it("classifies cancelled_stale as a neutral swept cleanup", () => {
    const o = classifySessionOutcome("cancelled_stale");
    expect(o.bucket).toBe("swept");
    expect(o.statusKey).toBe("swept");
    expect(o.tooltip).toMatch(/not a failure/i);
  });

  it("classifies a genuine job_failed as a red failure", () => {
    const o = classifySessionOutcome("failed", "job_failed");
    expect(o.bucket).toBe("failed");
    expect(o.statusKey).toBe("failed");
  });

  it("classifies a failed row with no reason as a red failure (don't hide it)", () => {
    expect(classifySessionOutcome("failed", null).bucket).toBe("failed");
    expect(classifySessionOutcome("failed").statusKey).toBe("failed");
  });

  it("demotes lifecycle/capacity cancels on a failed row to neutral swept", () => {
    for (const reason of [
      "queue_timeout",
      "heartbeat_timeout",
      "no_worker_online",
      "user_cancelled",
      "issue_busy",
      "waiting_on_dep",
      "project_full",
      "runner_full",
    ]) {
      const o = classifySessionOutcome("failed", reason);
      expect(o.bucket, reason).toBe("swept");
      expect(o.statusKey, reason).toBe("swept");
    }
  });

  it("treats legacy pipeline_* / migration cleanup reasons as benign cleanup", () => {
    for (const reason of [
      "pipeline_completed",
      "pipeline_failed",
      "pipeline_cancelled",
      "migration_zombie_cleanup",
    ]) {
      const o = classifySessionOutcome("failed", reason);
      expect(o.bucket, reason).toBe("cleanup");
      expect(o.statusKey, reason).toBe("swept");
    }
  });

  it("returns active (deferring to statusToChip) for non-terminal states", () => {
    expect(classifySessionOutcome("running").bucket).toBe("active");
    expect(classifySessionOutcome("stalled").statusKey).toBe("zombie");
    expect(classifySessionOutcome("queued").statusKey).toBe("queued");
  });
});

describe("isRealFailure (only genuine failures count as attention)", () => {
  it("is true only for job_failed / unknown-reason failed rows", () => {
    expect(isRealFailure("failed", "job_failed")).toBe(true);
    expect(isRealFailure("failed", null)).toBe(true);
  });

  it("is false for swept / cleanup / success / cancelled_stale", () => {
    expect(isRealFailure("failed", "user_cancelled")).toBe(false);
    expect(isRealFailure("failed", "pipeline_completed")).toBe(false);
    expect(isRealFailure("cancelled_stale")).toBe(false);
    expect(isRealFailure("completed")).toBe(false);
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
