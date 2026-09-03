import { describe, expect, it } from "vitest";
import { aggregateStageInsights, cardStatus, groupIssuesByStage, median } from "./derive";
import type { PipelineIssueRow, StepDurationRow } from "./types";

function issue(over: Partial<PipelineIssueRow> & { id: string; status: string }): PipelineIssueRow {
  return {
    id: over.id,
    projectId: over.projectId ?? "p1",
    displayId: over.displayId ?? "ISS-1",
    title: over.title ?? "t",
    status: over.status,
    priority: over.priority ?? "medium",
    assigneeId: over.assigneeId ?? null,
  };
}

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

describe("aggregateStageInsights", () => {
  it("returns one row per stage in STAGES order with live counts", () => {
    const groups = groupIssuesByStage([
      issue({ id: "a", status: "open" }), // → triage
      issue({ id: "b", status: "confirmed" }), // → clarify (hosts the clarify step)
      issue({ id: "c", status: "in_progress" }), // → code
    ]);
    const rows = aggregateStageInsights(groups, []);
    expect(rows.map((r) => r.stage)).toEqual([
      "triage",
      "clarify",
      "plan",
      "code",
      "review",
      "test",
      "release",
    ]);
    expect(rows.find((r) => r.stage === "triage")?.count).toBe(1);
    expect(rows.find((r) => r.stage === "clarify")?.count).toBe(1);
    expect(rows.find((r) => r.stage === "code")?.count).toBe(1);
    // No durations → null median, zero cost.
    expect(rows.find((r) => r.stage === "triage")?.medianSec).toBeNull();
    expect(rows.find((r) => r.stage === "triage")?.cost).toBe(0);
  });

  it("folds step durations onto stages (median + summed cost), with fix → code", () => {
    const rows = aggregateStageInsights(groupIssuesByStage([]), [
      step({ step: "code", durationSeconds: 10, costUsd: 0.01 }),
      step({ step: "code", durationSeconds: 30, costUsd: 0.02 }),
      step({ step: "fix", durationSeconds: 20, costUsd: 0.03 }), // rolls into code
    ]);
    const code = rows.find((r) => r.stage === "code");
    expect(code?.samples).toBe(3);
    expect(code?.medianSec).toBe(20); // median of [10,20,30]
    expect(code?.cost).toBeCloseTo(0.06, 5);
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
