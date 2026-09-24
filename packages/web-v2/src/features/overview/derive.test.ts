import { describe, expect, it } from "vitest";
import { actionQueue } from "./derive";
import type { PulseResponse, PulseWork } from "./types";

function pulse(work: Partial<PulseWork>): PulseResponse {
  const empty = { total: 0, shown: [] };
  return {
    generatedAt: "2026-09-23T14:30:00.000Z",
    thresholds: {
      abandonedIssueSeconds: 3600,
      releaseWaitingSeconds: 86400,
      projectSilenceSeconds: 604800,
      silenceWarnSeconds: 86400,
      silenceAlarmSeconds: 259200,
      identityCap: 50,
    },
    liveness: {
      jobsRunning: 0,
      jobsQueued: 0,
      jobsHeld: 0,
      liveJobs: empty,
      stuckRuns: empty,
      lastJobAt: null,
      silenceSeconds: null,
      heartbeat: [],
      devices: { online: 0, draining: 0, total: 0 },
    },
    work: {
      buckets: { open: 0, inProgress: 0, awaitingRelease: 0, humanBlocked: 0 },
      abandoned: empty,
      releaseWaiting: empty,
      notOnLive: empty,
      liveUnmeasured: empty,
      silentProjects: empty,
      neverRanProjects: empty,
      humanBlockedAges: [],
      perProject: [],
      ...work,
    },
    flow: [],
    quality: {
      finished: { merged: 0, closedUnmerged: 0, dropped: 0 },
      reopened: { issues: 0, events: 0 },
      rework: { fix: 0, code: 0 },
      runFailure: {
        pipeline: { failed: 0, total: 0 },
        scheduler: { failed: 0, total: 0 },
        other: { failed: 0, total: 0 },
      },
      sessionFailures: [],
      pipelineFlow: [],
    },
  };
}

const NOW = Date.parse("2026-09-23T14:30:00.000Z");

describe("the action queue's production rows (ISS-1217)", () => {
  it("counts every closed issue not on production and links each one it names", () => {
    const rows = actionQueue(
      pulse({
        notOnLive: {
          total: 8,
          shown: [
            {
              documentId: "d442",
              issueRef: "ISS-442",
              title: "the queue shows the owner",
              status: "closed",
              projectSlug: "sid-desk",
              ageSeconds: 36000,
              liveBranch: "master",
              evidence: [{ sha: "11d071b3".padEnd(40, "0"), subject: "fix", via: "merged_commit" }],
            },
          ],
        },
      }),
      NOW,
    );
    const row = rows.find((r) => r.key === "notOnLive");
    expect(row).toMatchObject({ label: "Closed, not on production", count: 8 });
    expect(row?.records).toEqual([
      {
        key: "d442",
        label: "ISS-442",
        detail: "the queue shows the owner · 11d071b3 not on master",
        href: "/projects/sid-desk/issues/d442",
        ageSeconds: 36000,
      },
    ]);
  });

  it("lists each promote project Forge cannot compare, with its reason", () => {
    const rows = actionQueue(
      pulse({
        liveUnmeasured: {
          total: 1,
          shown: [
            {
              id: "p1",
              slug: "sid-desk",
              name: "Sid Desk",
              baseBranch: "staging",
              liveBranch: "master",
              reason: "this project has no active GitHub binding",
            },
          ],
        },
      }),
      NOW,
    );
    const row = rows.find((r) => r.key === "liveUnmeasured");
    expect(row?.count).toBe(1);
    expect(row?.records[0]).toMatchObject({
      label: "Sid Desk",
      detail: "this project has no active GitHub binding",
      href: "/projects/sid-desk",
    });
  });

  it("shows neither row while both lists are empty", () => {
    const keys = actionQueue(pulse({}), NOW).map((r) => r.key);
    expect(keys).not.toContain("notOnLive");
    expect(keys).not.toContain("liveUnmeasured");
  });
});
