import { describe, expect, it } from "vitest";
import { aggregateStepCosts, cardStatus, median } from "./derive";
import type { PipelineIssueRow, StepDurationRow } from "./types";

function step(over: Partial<StepDurationRow> & { step: string }): StepDurationRow {
  return {
    runId: over.runId ?? "r1",
    issueId: over.issueId ?? "i1",
    projectId: over.projectId ?? "p1",
    step: over.step,
    startedAt: over.startedAt ?? "2026-06-01T00:00:00Z",
    finishedAt: over.finishedAt ?? "2026-06-01T00:01:00Z",
    durationSeconds: over.durationSeconds ?? 10,
    costUsd: over.costUsd ?? 0.01,
  };
}

describe("median", () => {
  it("returns null for an empty list", () => {
    expect(median([])).toBeNull();
  });
  it("returns the middle of an odd-length list", () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  it("averages the two middles of an even-length list", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("aggregateStepCosts — the job types that actually ran (ISS-999)", () => {
	it("returns one row per job type on the rows, and none for a job type with no row", () => {
		const rows = aggregateStepCosts([step({ step: "code" }), step({ step: "test" })]);
		expect(rows.map((r) => r.step).sort()).toEqual(["code", "test"]);
	});

	it("keeps a job type outside the seven staged names under its own name", () => {
		const rows = aggregateStepCosts([step({ step: "drive", durationSeconds: 9 })]);
		expect(rows.map((r) => r.step)).toEqual(["drive"]);
		expect(rows[0].medianSec).toBe(9);
	});

	it("gives `fix` a row of its own rather than summing it into `code`", () => {
		const rows = aggregateStepCosts([
			step({ step: "code", durationSeconds: 10, costUsd: 0.01 }),
			step({ step: "fix", durationSeconds: 20, costUsd: 0.03 }),
		]);
		expect(rows.find((r) => r.step === "code")?.samples).toBe(1);
		expect(rows.find((r) => r.step === "fix")?.samples).toBe(1);
	});

	it("takes the median duration and the summed cost per job type", () => {
		const rows = aggregateStepCosts([
			step({ step: "code", durationSeconds: 10, costUsd: 0.01 }),
			step({ step: "code", durationSeconds: 30, costUsd: 0.02 }),
			step({ step: "code", durationSeconds: 20, costUsd: 0.03 }),
		]);
		expect(rows[0].samples).toBe(3);
		expect(rows[0].medianSec).toBe(20);
		expect(rows[0].cost).toBeCloseTo(0.06, 5);
	});

	it("orders slowest median first, so the caller's `[0]` IS the bottleneck", () => {
		const rows = aggregateStepCosts([
			step({ step: "code", durationSeconds: 10 }),
			step({ step: "test", durationSeconds: 90 }),
			step({ step: "plan", durationSeconds: 50 }),
		]);
		expect(rows.map((r) => r.step)).toEqual(["test", "plan", "code"]);
	});

	it("colours one of the seven from its own token and anything else neutrally", () => {
		const rows = aggregateStepCosts([step({ step: "code" }), step({ step: "drive" })]);
		expect(rows.find((r) => r.step === "code")?.color).toBe("var(--stage-code)");
		expect(rows.find((r) => r.step === "drive")?.color).toBe("var(--fg-subtle)");
	});

	it("returns nothing for an empty or absent window", () => {
		expect(aggregateStepCosts([])).toEqual([]);
		expect(aggregateStepCosts(undefined)).toEqual([]);
	});
});

describe("cardStatus", () => {
  const label = (s: string) => `label:${s}`;
  const issue = (over: Partial<PipelineIssueRow> = {}): PipelineIssueRow =>
    ({
      id: "i",
      projectId: "p",
      displayId: "ISS-903",
      title: "t",
      status: "in_progress",
      priority: "high",
      assigneeId: null,
      agentStatus: null,
      ...over,
    }) as PipelineIssueRow;
  const queuedHealth = (reason?: string) =>
    ({
      stage: "in_progress",
      queuedStep: {
        jobId: "a872c0b8",
        jobType: "drive",
        stageStatus: "open",
        queuedAt: "2026-09-03T14:43:00.000Z",
        retryAfterAt: null,
      },
      ...(reason
        ? { waitingOn: { reason, since: "2026-09-03T14:43:00.000Z", details: {} } }
        : {}),
    }) as PipelineIssueRow["pipelineHealth"];

  it("lets a queued step outrank the run's own Running", () => {
    const card = cardStatus(
      issue({ pipelineHealth: queuedHealth("runner_stale") }),
      { status: "running" },
      label as never,
    );
    expect(card.status).toBe("waiting");
    expect(card.label).toBe("No runner online");
    expect(card.domain).toBe("session");
    expect(card.waitingReason).toMatch(/No runner is online/);
  });

  it("says Queued with no gate sentence for a step merely awaiting its turn", () => {
    const card = cardStatus(
      issue({ pipelineHealth: queuedHealth() }),
      { status: "running" },
      label as never,
    );
    expect(card.status).toBe("queued");
    expect(card.label).toBe("Queued");
    expect(card.waitingReason).toBe("");
  });

  it("keeps the run's status when a session is live", () => {
    const card = cardStatus(
      issue({ pipelineHealth: queuedHealth("runner_stale"), agentStatus: "running" }),
      { status: "running" },
      label as never,
    );
    expect(card.status).toBe("running");
    expect(card.label).toBeUndefined();
  });

  it("shows the gate for a deferred retry, whose agentStatus reads failed", () => {
    const card = cardStatus(
      issue({ pipelineHealth: queuedHealth("runner_stale"), agentStatus: "failed" }),
      { status: "running" },
      label as never,
    );
    expect(card.label).toBe("No runner online");
  });

  it("falls back to the issue's own lifecycle label with no run and nothing queued", () => {
    const card = cardStatus(issue(), undefined, label as never);
    expect(card.domain).toBe("issue");
    expect(card.label).toBe("label:in_progress");
  });
});
