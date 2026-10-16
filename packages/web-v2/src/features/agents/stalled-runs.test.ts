import { describe, expect, it } from "vitest";
import type { PipelineRunListItem } from "@/features/runs/types";
import { stalledRuns, workedRuns } from "./stalled-runs";

const NOW = Date.parse("2026-10-16T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function run(over: Partial<PipelineRunListItem>): PipelineRunListItem {
  return {
    id: "r1",
    status: "running",
    liveJobs: 0,
    lastSessionBeatAt: null,
    startedAt: ago(60 * 60_000),
    ...over,
  } as PipelineRunListItem;
}

// ISS-1228 round 9: core decides when a silent session is over, by ending it. A run core still holds
// a session open on has an agent behind it, however long that agent has been quiet; the screen keeps
// no silence threshold of its own.
describe("worked and stalled runs", () => {
  it("calls a run worked while core holds its session open, five minutes quiet included", () => {
    const quiet = run({ lastSessionBeatAt: ago(5 * 60_000) });
    expect(workedRuns([quiet])).toHaveLength(1);
    expect(stalledRuns([quiet], NOW)).toHaveLength(0);
  });

  it("calls a run with no open session and no live job stalled once its start-up grace is over", () => {
    const empty = run({});
    expect(workedRuns([empty])).toHaveLength(0);
    expect(stalledRuns([empty], NOW)).toHaveLength(1);
  });

  it("does not call a run stalled inside its start-up grace", () => {
    const young = run({ startedAt: ago(60_000) });
    expect(stalledRuns([young], NOW)).toHaveLength(0);
  });

  it("calls a run with a live job worked", () => {
    expect(workedRuns([run({ liveJobs: 1 })])).toHaveLength(1);
  });
});
