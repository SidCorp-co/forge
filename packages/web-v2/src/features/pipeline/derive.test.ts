import { describe, expect, it } from "vitest";
import { aggregateStageInsights, groupIssuesByStage, median } from "./derive";
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
      issue({ id: "b", status: "confirmed" }), // → triage
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
    expect(rows.find((r) => r.stage === "triage")?.count).toBe(2);
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
