import { describe, expect, it } from "vitest";
import {
  ACTION_ORDER,
  actionQueue,
  bucketHref,
  formatElapsed,
  projectSilenceRows,
  qualityRates,
  silenceMark,
  waffleCells,
} from "./derive";
import type {
  PulseIssueIdentity,
  PulseProjectIdentity,
  PulseProjectRow,
  PulseQuality,
  PulseResponse,
  PulseRunIdentity,
  PulseThresholds,
} from "./types";

const THRESHOLDS: PulseThresholds = {
  abandonedIssueSeconds: 3600,
  releaseWaitingSeconds: 86_400,
  projectSilenceSeconds: 604_800,
  silenceWarnSeconds: 86_400,
  silenceAlarmSeconds: 259_200,
  identityCap: 50,
};

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

const issue = (ref: string, ageSeconds: number): PulseIssueIdentity => ({
  documentId: `doc-${ref}`,
  issueRef: ref,
  title: `${ref} title`,
  status: "in_progress",
  projectSlug: "forge-dev",
  ageSeconds,
});

const run = (id: string, ageSeconds: number): PulseRunIdentity => ({
  runId: id,
  projectSlug: "forge-dev",
  issueRef: null,
  issueDocId: null,
  ageSeconds,
});

const project = (
  slug: string,
  backlog: number,
  lastIssueRunAt: string | null,
): PulseProjectIdentity => ({ id: `p-${slug}`, slug, name: slug, backlog, lastIssueRunAt });

const projectRow = (over: Partial<PulseProjectRow> & { slug: string }): PulseProjectRow => ({
  id: `p-${over.slug}`,
  name: over.slug,
  open: 0,
  inProgress: 0,
  awaitingRelease: 0,
  humanBlocked: 0,
  stuckRuns: 0,
  abandonedIssues: 0,
  lastIssueRunAt: null,
  ...over,
});

const EMPTY_QUALITY: PulseQuality = {
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
};

function pulse(over: {
  stuckRuns?: { total: number; shown: PulseRunIdentity[] };
  abandoned?: { total: number; shown: PulseIssueIdentity[] };
  releaseWaiting?: { total: number; shown: PulseIssueIdentity[] };
  silentProjects?: { total: number; shown: PulseProjectIdentity[] };
  neverRanProjects?: { total: number; shown: PulseProjectIdentity[] };
  perProject?: PulseProjectRow[];
  quality?: PulseQuality;
} = {}): PulseResponse {
  return {
    generatedAt: new Date(NOW).toISOString(),
    thresholds: THRESHOLDS,
    liveness: {
      jobsRunning: 0,
      jobsQueued: 0,
      jobsHeld: 0,
      liveJobs: { total: 0, shown: [] },
      stuckRuns: over.stuckRuns ?? { total: 0, shown: [] },
      lastJobAt: null,
      silenceSeconds: null,
      heartbeat: [],
      devices: { online: 0, draining: 0, total: 0 },
    },
    work: {
      buckets: { open: 0, inProgress: 0, awaitingRelease: 0, humanBlocked: 0 },
      abandoned: over.abandoned ?? { total: 0, shown: [] },
      releaseWaiting: over.releaseWaiting ?? { total: 0, shown: [] },
      silentProjects: over.silentProjects ?? { total: 0, shown: [] },
      neverRanProjects: over.neverRanProjects ?? { total: 0, shown: [] },
      humanBlockedAges: [],
      perProject: over.perProject ?? [],
    },
    flow: [],
    quality: over.quality ?? EMPTY_QUALITY,
  };
}

describe("silenceMark", () => {
  it("reads both marks off the response and not off a constant", () => {
    expect(silenceMark(null, THRESHOLDS)).toBe("calm");
    expect(silenceMark(THRESHOLDS.silenceWarnSeconds - 1, THRESHOLDS)).toBe("calm");
    expect(silenceMark(THRESHOLDS.silenceWarnSeconds, THRESHOLDS)).toBe("warn");
    expect(silenceMark(THRESHOLDS.silenceAlarmSeconds, THRESHOLDS)).toBe("alarm");
  });

  // cm:guard the cutoffs must follow the RESPONSE, so this halves both marks and expects the verdict to move with them — a client comparing against its own constant passes every assertion above and fails only this one (ISS-988 criterion 23)
  it("moves its verdict when the response moves its thresholds", () => {
    const halved = {
      ...THRESHOLDS,
      silenceWarnSeconds: THRESHOLDS.silenceWarnSeconds / 2,
      silenceAlarmSeconds: THRESHOLDS.silenceAlarmSeconds / 2,
    };
    const seconds = THRESHOLDS.silenceWarnSeconds - 1;
    expect(silenceMark(seconds, THRESHOLDS)).toBe("calm");
    expect(silenceMark(seconds, halved)).toBe("warn");
  });
});

describe("bucketHref", () => {
  it("names every status the bucket counted, comma-joined", () => {
    expect(bucketHref("forge-dev", "humanBlocked")).toBe(
      "/projects/forge-dev/issues?status=waiting,needs_info,on_hold",
    );
  });

  it("narrows in-progress to the five statuses that bucket is drawn from", () => {
    const href = bucketHref("erp", "inProgress");
    expect(href).toContain("status=in_progress,developed,testing,tested,reopen");
    expect(href).not.toContain("closed");
  });
});

describe("waffleCells", () => {
  it("carries each bucket's own count rather than a share of a fixed grid", () => {
    const cells = waffleCells({
      open: 342,
      inProgress: 79,
      awaitingRelease: 0,
      humanBlocked: 70,
    });
    expect(cells.map((c) => c.count)).toEqual([342, 79, 0, 70]);
  });

  it("keeps an all-zero bucket as a cell so the reader sees the zero", () => {
    const cells = waffleCells({ open: 0, inProgress: 0, awaitingRelease: 0, humanBlocked: 0 });
    expect(cells).toHaveLength(4);
  });
});

describe("actionQueue", () => {
  it("names one row per condition that holds records, and no row for an empty one", () => {
    const rows = actionQueue(
      pulse({
        stuckRuns: { total: 2, shown: [run("r1", 600), run("r2", 60)] },
        abandoned: { total: 1, shown: [issue("ISS-1", 100)] },
      }),
      NOW,
    );
    expect(rows.map((r) => r.key)).toEqual(["stuckRuns", "abandonedIssues"]);
  });

  it("says who ends each condition", () => {
    const rows = actionQueue(
      pulse({
        stuckRuns: { total: 1, shown: [run("r1", 10)] },
        abandoned: { total: 1, shown: [issue("ISS-1", 10)] },
      }),
      NOW,
    );
    expect(rows.find((r) => r.key === "stuckRuns")?.owner).toBe("machine");
    expect(rows.find((r) => r.key === "abandonedIssues")?.owner).toBe("person");
  });

  // cm:guard the oldest record has to WIN over the larger count, so this plants a 1-record row that is older than a 9-record one — an ordering keyed on count first passes every other assertion here and fails only this (ISS-988 criterion 33)
  it("orders by the oldest record, oldest first, over the bigger count", () => {
    const rows = actionQueue(
      pulse({
        stuckRuns: { total: 9, shown: [run("r1", 60)] },
        abandoned: { total: 1, shown: [issue("ISS-1", 99_999)] },
      }),
      NOW,
    );
    expect(rows.map((r) => r.key)).toEqual(["abandonedIssues", "stuckRuns"]);
  });

  it("breaks a tie on the oldest record by the larger record count", () => {
    const rows = actionQueue(
      pulse({
        stuckRuns: { total: 1, shown: [run("r1", 500)] },
        abandoned: { total: 7, shown: [issue("ISS-1", 500)] },
      }),
      NOW,
    );
    expect(rows.map((r) => r.key)).toEqual(["abandonedIssues", "stuckRuns"]);
  });

  // cm:guard two rows alike in age AND count must fall back to ACTION_ORDER, or the same response renders in a different order on each refresh — the assertion is the FIXED sequence, not merely that both rows appear (ISS-988 criterion 34)
  it("falls back to the fixed order when age and count both tie", () => {
    const rows = actionQueue(
      pulse({
        silentProjects: { total: 1, shown: [project("a", 3, "2026-09-12T11:50:00.000Z")] },
        releaseWaiting: { total: 1, shown: [issue("ISS-1", 600)] },
      }),
      NOW,
    );
    expect(rows.map((r) => r.key)).toEqual(["releaseWaiting", "silentProjects"]);
    expect(ACTION_ORDER.indexOf("releaseWaiting")).toBeLessThan(
      ACTION_ORDER.indexOf("silentProjects"),
    );
  });

  it("carries the whole count beside the records the response named", () => {
    const rows = actionQueue(
      pulse({ abandoned: { total: 70, shown: [issue("ISS-1", 10), issue("ISS-2", 20)] } }),
      NOW,
    );
    expect(rows[0].count).toBe(70);
    expect(rows[0].records).toHaveLength(2);
  });

  // cm:guard a never-ran project is the EXTREME of "how long since a run"; giving it a zero age sorts the worst row last, which is the inverse of what the queue is for (ISS-988 criterion 30)
  it("sorts a project that has never run above one merely silent", () => {
    const rows = actionQueue(
      pulse({
        neverRanProjects: { total: 1, shown: [project("never", 200, null)] },
        silentProjects: { total: 1, shown: [project("quiet", 5, "2026-08-01T00:00:00.000Z")] },
      }),
      NOW,
    );
    expect(rows[0].key).toBe("neverRanProjects");
  });

  it("includes all five conditions the inbox does not carry", () => {
    const rows = actionQueue(
      pulse({
        stuckRuns: { total: 1, shown: [run("r", 5)] },
        abandoned: { total: 1, shown: [issue("ISS-1", 5)] },
        releaseWaiting: { total: 1, shown: [issue("ISS-2", 5)] },
        neverRanProjects: { total: 1, shown: [project("n", 1, null)] },
        silentProjects: { total: 1, shown: [project("s", 1, "2026-08-01T00:00:00.000Z")] },
      }),
      NOW,
    );
    expect(new Set(rows.map((r) => r.key))).toEqual(new Set(ACTION_ORDER));
  });
});

describe("projectSilenceRows", () => {
  it("orders by how long each project has gone without an issue run", () => {
    const rows = projectSilenceRows(
      pulse({
        perProject: [
          projectRow({ slug: "recent", lastIssueRunAt: "2026-09-12T11:00:00.000Z" }),
          projectRow({ slug: "old", lastIssueRunAt: "2026-08-01T00:00:00.000Z" }),
        ],
      }),
      NOW,
    );
    expect(rows.map((r) => r.slug)).toEqual(["old", "recent"]);
  });

  // cm:guard a never-ran project is FLAGGED rather than given a silence figure: rendering "no pipeline has ever run here" as "silent for 103 days" is a different fact the reader would act on differently (ISS-988 criterion 30)
  it("flags a project that has never run instead of dating it", () => {
    const rows = projectSilenceRows(
      pulse({
        perProject: [
          projectRow({ slug: "old", lastIssueRunAt: "2026-08-01T00:00:00.000Z" }),
          projectRow({ slug: "never", lastIssueRunAt: null }),
        ],
      }),
      NOW,
    );
    expect(rows[0].slug).toBe("never");
    expect(rows[0].neverRan).toBe(true);
    expect(rows[0].silenceSeconds).toBeNull();
    expect(rows[1].neverRan).toBe(false);
  });
});

describe("qualityRates", () => {
  // cm:guard the rate is computed from summed COUNTS: this plants a 1-of-1 project beside a 1-of-99 one, where a mean of the two per-project rates gives ~0.5 and the honest figure is 0.02 (ISS-988 criterion 52)
  it("is a rate over the totals, never a mean of per-project rates", () => {
    const rates = qualityRates({
      ...EMPTY_QUALITY,
      finished: { merged: 2, closedUnmerged: 98, dropped: 0 },
    });
    expect(rates.finishedTotal).toBe(100);
    expect(rates.mergedShare).toBeCloseTo(0.02, 5);
  });

  it("reports no rework ratio where nothing was coded, rather than dividing by zero", () => {
    const rates = qualityRates({ ...EMPTY_QUALITY, rework: { fix: 3, code: 0 } });
    expect(rates.reworkRatio).toBeNull();
  });

  // cm:guard an unset failure reason arrives as the row `unclassified` and is counted, never dropped: 66% of failures carried no reason on 2026-09-12, and a share computed over the classified rows alone reports a third of the truth as the whole (ISS-988 criterion 21)
  it("counts the unclassified reason into the share rather than skipping it", () => {
    const rates = qualityRates({
      ...EMPTY_QUALITY,
      sessionFailures: [
        { reason: "unclassified", count: 66 },
        { reason: "runner_unreachable", count: 34 },
      ],
    });
    expect(rates.sessionFailureTotal).toBe(100);
    expect(rates.unclassifiedShare).toBeCloseTo(0.66, 5);
  });

  it("reports no unclassified share where nothing failed", () => {
    expect(qualityRates(EMPTY_QUALITY).unclassifiedShare).toBeNull();
  });
});

describe("formatElapsed", () => {
  it("says never for an absent age rather than printing a zero", () => {
    expect(formatElapsed(null)).toBe("never");
  });

  it("steps through seconds, minutes, hours and days", () => {
    expect(formatElapsed(45)).toBe("45s");
    expect(formatElapsed(120)).toBe("2m");
    expect(formatElapsed(7200)).toBe("2h");
    expect(formatElapsed(259_200)).toBe("3d");
  });
});
