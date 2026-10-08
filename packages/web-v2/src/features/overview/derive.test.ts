import { describe, expect, it } from "vitest";
import { OPEN_WORK_STATES, WORK_STATE_LABELS } from "@forge/contracts/work-state";
import { actionQueue, ageText, bucketHref, projectSilenceRows, waffleCells } from "./derive";
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
      buckets: { open: 0, in_flight: 0, awaiting_release: 0, blocked_on_person: 0 },
      abandoned: empty,
      releaseWaiting: empty,
      notOnLive: empty,
      liveUnmeasured: empty,
      silentProjects: empty,
      neverRanProjects: empty,
      blockedOnPersonAges: [],
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
    expect(row?.hint).toBe(
      "Forge cannot tell whether closed issues here reached the live branch: the comparison failed, was cut short, or was taken before they merged.",
    );
  });

  it("gives an uncomparable project no age, since a refusal's reading time is not how long it has failed", () => {
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
              reason: "no deploy key",
            },
          ],
        },
      }),
      NOW,
    );
    const row = rows.find((r) => r.key === "liveUnmeasured");
    expect(row?.records[0]?.ageSeconds).toBeNull();
    expect(row?.oldestSeconds).toBeNull();
    expect(ageText(row?.oldestSeconds ?? null)).toBeNull();
    expect(ageText(0)).toBe("0s");
    expect(ageText(Number.MAX_SAFE_INTEGER)).toBe("never ran");
  });

  it("shows neither row while both lists are empty", () => {
    const keys = actionQueue(pulse({}), NOW).map((r) => r.key);
    expect(keys).not.toContain("notOnLive");
    expect(keys).not.toContain("liveUnmeasured");
  });
});

describe("the buckets are the open work states (ISS-1156)", () => {
  it("draws one waffle cell per open state, worded and counted as the state is", () => {
    const cells = waffleCells({ open: 56, in_flight: 11, awaiting_release: 1, blocked_on_person: 4 });
    expect(cells.map((c) => [c.key, c.label, c.count])).toEqual([
      ["open", "Open, not picked up", 56],
      ["in_flight", "In flight", 11],
      ["awaiting_release", "Awaiting release", 1],
      ["blocked_on_person", "Blocked on a person", 4],
    ]);
    expect(cells.map((c) => c.label)).toEqual(OPEN_WORK_STATES.map((s) => WORK_STATE_LABELS[s]));
  });

  it("opens the issues list on the segment that counted a figure, not on a list of statuses", () => {
    for (const state of OPEN_WORK_STATES) {
      expect(bucketHref("forge-dev", state)).toBe(`/projects/forge-dev/issues?filter=${state}`);
    }
  });

  it("sums a project's backlog from its four open states and no others", () => {
    const rows = projectSilenceRows(
      pulse({
        perProject: [
          {
            id: "p",
            slug: "alpha",
            name: "Alpha",
            open: 5,
            in_flight: 7,
            awaiting_release: 1,
            blocked_on_person: 3,
            stuckRuns: 0,
            abandonedIssues: 0,
            lastIssueRunAt: null,
          },
        ],
      }),
      NOW,
    );
    expect(rows[0]?.backlog).toBe(16);
    expect(rows[0]?.buckets).toEqual({ open: 5, in_flight: 7, awaiting_release: 1, blocked_on_person: 3 });
  });
});
