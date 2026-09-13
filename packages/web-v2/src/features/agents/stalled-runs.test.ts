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
  // cm:guard freshness is graded on the BEAT and not on a session's status: between a box dying and the sweeper acting there are `running` rows hours old, and taking those as proof of life is how an abandoned run stays uncounted for as long as the reaper is behind.
  it("takes a fresh beat and refuses a stale one", () => {
    expect(sessionIsBeating({ lastSessionBeatAt: ago(HEARTBEAT_REAP_MS) }, NOW)).toBe(true);
    expect(sessionIsBeating({ lastSessionBeatAt: ago(HEARTBEAT_REAP_MS + 1) }, NOW)).toBe(false);
  });

  // cm:guard an absent beat is NOT a beat: `null` is both "this run has no session" and "the caller did not load it", and reading either as alive is the reassurance this whole count exists to stop giving.
  it("refuses a run with no beat at all, and one whose beat is unreadable", () => {
    expect(sessionIsBeating({ lastSessionBeatAt: null }, NOW)).toBe(false);
    expect(sessionIsBeating({ lastSessionBeatAt: "not a date" }, NOW)).toBe(false);
  });
});

describe("the runs nothing is working on", () => {
  // cm:guard the FALSIFYING pair for the whole predicate, measured on beta 2026-09-13: of the six non-terminal runs reading `liveJobs: 0`, all six were master-lane runs with a live heartbeat. A version asking only about `liveJobs` passes the first assertion and fails the second.
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

  // cm:guard a run whose session STOPPED reporting is counted, which is the case a `status === 'running'` reading would miss entirely: the row is still there, it is just hours old.
  it("takes a run whose session went quiet past the threshold", () => {
    const out = stalledRuns([run({ lastSessionBeatAt: ago(HEARTBEAT_REAP_MS + 1) })], NOW);
    expect(out).toHaveLength(1);
  });

  it("keeps a run with live jobs out whatever its session says", () => {
    expect(stalledRuns([run({ liveJobs: 1 })], NOW)).toEqual([]);
  });

  // cm:guard a terminal run is not stalled, it is finished — counting one would put every completed run on this project into the number the moment the sweeper closed it.
  it("looks only at runs that are still open", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      expect(stalledRuns([run({ status })], NOW), status).toEqual([]);
    }
    expect(stalledRuns([run({ status: "paused" })], NOW)).toHaveLength(1);
  });

  it("counts nothing when there is nothing to count", () => {
    expect(stalledRuns(undefined, NOW)).toEqual([]);
    expect(stalledRuns([], NOW)).toEqual([]);
  });
});
