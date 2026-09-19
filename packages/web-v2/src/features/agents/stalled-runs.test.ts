import { describe, expect, it } from "vitest";
import type { PipelineRunListItem } from "@/features/pipeline/types";
import { HEARTBEAT_REAP_MS } from "@/features/sessions/types";
import { sessionIsBeating, stalledRuns } from "./stalled-runs";

const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const run = (over: Partial<PipelineRunListItem> = {}): PipelineRunListItem =>
  ({
    id: "pr-1",
    projectId: "p-1",
    issueId: null,
    issueRef: null,
    issueTitle: null,
    kind: "issue",
    status: "running",
    currentStep: "drive",
    startedAt: ago(3_600_000),
    finishedAt: null,
    cost: {
      estimatedCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      requests: 0,
      sampleCount: 0,
    },
    liveJobs: 0,
    lastSessionBeatAt: null,
    ...over,
  }) as PipelineRunListItem;

describe("what counts as proof a run is alive", () => {
  it("takes a fresh beat and refuses a stale one", () => {
    expect(sessionIsBeating({ lastSessionBeatAt: ago(HEARTBEAT_REAP_MS) }, NOW)).toBe(true);
    expect(sessionIsBeating({ lastSessionBeatAt: ago(HEARTBEAT_REAP_MS + 1) }, NOW)).toBe(false);
  });

  it("refuses a run with no beat at all, and one whose beat is unreadable", () => {
    expect(sessionIsBeating({ lastSessionBeatAt: null }, NOW)).toBe(false);
    expect(sessionIsBeating({ lastSessionBeatAt: "not a date" }, NOW)).toBe(false);
  });
});

describe("the runs nothing is working on", () => {
  it("keeps a run with no job but a live agent out, and takes one with neither", () => {
    const out = stalledRuns(
      [
        run({ id: "pr-master", lastSessionBeatAt: ago(5_000) }),
        run({ id: "pr-orphan", lastSessionBeatAt: null }),
      ],
      NOW,
    );

    expect(out.map((r) => r.id)).toEqual(["pr-orphan"]);
  });

  it("takes a run whose session went quiet past the threshold", () => {
    const out = stalledRuns([run({ lastSessionBeatAt: ago(HEARTBEAT_REAP_MS + 1) })], NOW);
    expect(out).toHaveLength(1);
  });

  it("keeps a run with live jobs out whatever its session says", () => {
    expect(stalledRuns([run({ liveJobs: 1 })], NOW)).toEqual([]);
  });

  it("looks only at runs that are still open", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      expect(stalledRuns([run({ status })], NOW), status).toEqual([]);
    }
    expect(stalledRuns([run({ status: "paused" })], NOW)).toHaveLength(1);
  });

  it("gives a run that has never reported a startup grace, and takes one that outlived it", () => {
    const starting = run({ id: "pr-starting", startedAt: ago(1_000), lastSessionBeatAt: null });
    const silent = run({
      id: "pr-silent",
      startedAt: ago(HEARTBEAT_REAP_MS + 1),
      lastSessionBeatAt: null,
    });

    expect(stalledRuns([starting, silent], NOW).map((r) => r.id)).toEqual(["pr-silent"]);
  });

  it("gives no grace to a young run whose beat has already gone stale", () => {
    const out = stalledRuns(
      [
        run({
          id: "pr-died-young",
          startedAt: ago(1_000),
          lastSessionBeatAt: ago(HEARTBEAT_REAP_MS + 1),
        }),
      ],
      NOW,
    );
    expect(out.map((r) => r.id)).toEqual(["pr-died-young"]);
  });

  it("gives no grace to a run whose start time cannot be read", () => {
    expect(stalledRuns([run({ startedAt: "not a date", lastSessionBeatAt: null })], NOW)).toHaveLength(1);
  });

  it("counts nothing when there is nothing to count", () => {
    expect(stalledRuns(undefined, NOW)).toEqual([]);
    expect(stalledRuns([], NOW)).toEqual([]);
  });
});
