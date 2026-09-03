import { describe, expect, it, vi } from "vitest";
import { deriveQueuedStep, WAITING_REASON_SHORT } from "./waiting";
import type { PipelineHealth, WaitingReason } from "./types";

const QUEUED_AT = "2026-09-03T14:43:00.000Z";
const NOW = new Date("2026-09-03T17:22:00.000Z");

const health = (over: Partial<PipelineHealth> = {}): PipelineHealth => ({
  stage: "in_progress",
  queuedAt: QUEUED_AT,
  queuedStep: {
    jobId: "a872c0b8",
    jobType: "drive",
    stageStatus: "open",
    queuedAt: QUEUED_AT,
    retryAfterAt: null,
  },
  ...over,
});

describe("deriveQueuedStep", () => {
  it("returns null when the issue has a live session — the live panel owns that render", () => {
    expect(deriveQueuedStep(health(), true)).toBeNull();
  });

  it("returns null when there is no queued step", () => {
    expect(deriveQueuedStep({ stage: "approved" }, false)).toBeNull();
    expect(deriveQueuedStep(undefined, false)).toBeNull();
  });

  it("names the step and the gate for the incident shape (runner_stale)", () => {
    const out = deriveQueuedStep(
      health({
        waitingOn: { reason: "runner_stale", since: QUEUED_AT, details: { freshRunners: 0 } },
      }),
      false,
    );
    expect(out?.jobType).toBe("drive");
    expect(out?.queuedAt).toBe(QUEUED_AT);
    expect(out?.gate?.reason).toBe("runner_stale");
    expect(out?.gate?.short).toBe(WAITING_REASON_SHORT.runner_stale);
    expect(out?.gate?.detail).toMatch(/no runner is online/i);
    expect(out?.gate?.who).toMatch(/bring a runner back/i);
  });

  it("reports NO gate for a step merely awaiting its turn", () => {
    const out = deriveQueuedStep(health(), false);
    expect(out?.jobType).toBe("drive");
    expect(out?.gate).toBeNull();
  });

  it("carries the next attempt time when the step has one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const retryAfterAt = new Date(NOW.getTime() + 45_000).toISOString();
    const out = deriveQueuedStep(
      health({
        queuedStep: {
          jobId: "a872c0b8",
          jobType: "fix",
          stageStatus: "reopen",
          queuedAt: QUEUED_AT,
          retryAfterAt,
        },
        waitingOn: { reason: "retry_cooldown", since: QUEUED_AT, details: {} },
      }),
      false,
    );
    expect(out?.nextAttempt).toBe("in 1 min");
    vi.useRealTimers();
  });

  it("leaves nextAttempt empty when no attempt time is known", () => {
    expect(deriveQueuedStep(health(), false)?.nextAttempt).toBe("");
  });

  it("uses the held job's own copy when a held sibling owns the gate", () => {
    const out = deriveQueuedStep(
      health({
        waitingOn: {
          reason: "job_held",
          since: QUEUED_AT,
          details: { holdReason: "retry_rounds_exhausted" },
        },
      }),
      false,
    );
    expect(out?.gate?.reason).toBe("job_held");
    expect(out?.gate?.who).toMatch(/cancel the step/i);
  });
});

describe("WAITING_REASON_SHORT", () => {
  const REASONS: WaitingReason[] = [
    "issue_busy",
    "job_held",
    "run_not_running",
    "retry_cooldown",
    "stale_trigger",
    "waiting_on_dep",
    "waiting_on_decomp_children",
    "project_full",
    "runner_stale",
    "runner_full",
  ];

  it("covers every reason with a chip-length label", () => {
    for (const r of REASONS) {
      const label = WAITING_REASON_SHORT[r];
      expect(label, r).toBeTruthy();
      expect(label.length, `${r}: "${label}"`).toBeLessThanOrEqual(24);
    }
  });
});
