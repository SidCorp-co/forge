import { describe, expect, it, vi } from "vitest";
import {
  deriveQueuedStep,
  hasLiveAgentSession,
  queuedChipStatus,
  WAITING_REASON_SHORT,
} from "./waiting";
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

describe("gate tone", () => {
	it("asks for attention only where the copy asks the reader to act", () => {
		const needs = (reason: WaitingReason, details: Record<string, unknown> = {}) =>
			deriveQueuedStep(health({ waitingOn: { reason, since: QUEUED_AT, details } }), false)
				?.gate?.needsAction;
		expect(needs("runner_stale")).toBe(true);
		expect(needs("run_not_running")).toBe(true);
		expect(needs("waiting_on_dep")).toBe(true);
		expect(needs("retry_cooldown")).toBe(false);
		expect(needs("project_full")).toBe(false);
		expect(needs("runner_full")).toBe(false);
		expect(needs("stale_trigger")).toBe(false);
		expect(needs("issue_busy")).toBe(false);
	});

	it("branches job_held on the hold reason, as its copy does", () => {
		const held = (holdReason: string) =>
			deriveQueuedStep(
				health({ waitingOn: { reason: "job_held", since: QUEUED_AT, details: { holdReason } } }),
				false,
			)?.gate;
		expect(held("monthly_budget_exhausted")?.needsAction).toBe(false);
		expect(held("retry_rounds_exhausted")?.needsAction).toBe(true);
	});

	it("wears the calm queued tone for a self-clearing gate and attention for the rest", () => {
		const step = (reason: WaitingReason) =>
			deriveQueuedStep(health({ waitingOn: { reason, since: QUEUED_AT, details: {} } }), false);
		const stale = step("runner_stale");
		const cooldown = step("retry_cooldown");
		const ungated = deriveQueuedStep(health(), false);
		if (!stale || !cooldown || !ungated) throw new Error("expected a queued step");
		expect(queuedChipStatus(stale)).toBe("waiting");
		expect(queuedChipStatus(cooldown)).toBe("queued");
		expect(queuedChipStatus(ungated)).toBe("queued");
	});
});

describe("hasLiveAgentSession", () => {
  it("counts only a session that is actually executing or dispatched", () => {
    expect(hasLiveAgentSession("running")).toBe(true);
    expect(hasLiveAgentSession("queued")).toBe(true);
    expect(hasLiveAgentSession(null)).toBe(false);
    expect(hasLiveAgentSession(undefined)).toBe(false);
    expect(hasLiveAgentSession("completed")).toBe(false);
  });

  it("does NOT count `failed` — that is what a deferred retry reads as", () => {
    expect(hasLiveAgentSession("failed")).toBe(false);
  });
});

describe("a deferred retry", () => {
  it("still surfaces its gate, though the last attempt failed", () => {
    const out = deriveQueuedStep(
      health({
        waitingOn: { reason: "runner_stale", since: QUEUED_AT, details: {} },
      }),
      hasLiveAgentSession("failed"),
    );
    expect(out?.gate?.short).toBe("No runner online");
  });
});

describe("a gate this build has no words for", () => {
  it("says so rather than claiming the step is merely awaiting its turn", () => {
    const out = deriveQueuedStep(
      health({
        waitingOn: {
          reason: "gate_added_after_this_build" as WaitingReason,
          since: QUEUED_AT,
          details: {},
        },
      }),
      false,
    );
    expect(out?.gate).not.toBeNull();
    expect(out?.gate?.short).toBe("Waiting");
    expect(out?.gate?.detail).toMatch(/does not recognise/);
    expect(out?.gate?.needsAction).toBe(true);
    expect(queuedChipStatus(out as NonNullable<typeof out>)).toBe("waiting");
  });
});
