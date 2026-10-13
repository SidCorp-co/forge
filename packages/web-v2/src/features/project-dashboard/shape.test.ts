// What the project is doing, read from the reads the page holds (ISS-1159). Each boundary the shape
// turns on is pinned by a case that fails without it: the fourteen-day line, zero, an unread answer.

import { describe, expect, it } from "vitest";
import type { IssueRow } from "@/features/issues/types";
import type { PipelineRunListItem } from "@/features/pipeline/types";
import type { DashboardAttentionItem } from "./derive";
import {
  STUCK_RUN_SECONDS,
  type ShapeInput,
  ageBand,
  parkedAges,
  projectShape,
  slowestComparison,
  spendComparison,
  stuckRuns,
  throughputComparison,
  unreadStatement,
} from "./shape";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const DAY = 86_400;

const item = (over: Partial<DashboardAttentionItem> = {}): DashboardAttentionItem => ({
  key: "k",
  actionKind: "input",
  actionLabel: "Provide info",
  title: "A question",
  issueRef: "ISS-7",
  link: "/projects/p/issues/d7",
  since: ago(2 * 3600),
  sinceBasis: "entered",
  ...over,
});

const input = (over: Partial<ShapeInput> = {}): ShapeInput => ({
  attention: { read: "ok" },
  runs: { read: "ok" },
  parked: { read: "ok" },
  items: [],
  cut: null,
  slug: "p",
  liveRuns: 0,
  stuckRuns: [],
  failedJobs: 0,
  releaseRuns: 0,
  releaseIssues: 0,
  now: NOW,
  ...over,
});

const run = (over: Partial<PipelineRunListItem>): PipelineRunListItem =>
  ({ id: "r1", status: "running", liveJobs: 0, startedAt: ago(5 * 3600), lastSessionBeatAt: null, ...over }) as PipelineRunListItem;

describe("the shape of a project", () => {
  it("is quiet, and says nothing needs anyone, only where every read is in and holds nothing", () => {
    const r = projectShape(input());
    expect(r.shape).toBe("quiet");
    expect(r.headline).toBe("Nothing needs anyone.");
    expect(r.band).toBeNull();
  });

  it("is working with a sentence counting each part that is not zero, each worded with what it counts", () => {
    const r = projectShape(input({ liveRuns: 3, items: [item(), item({ key: "k2" })], releaseRuns: 1 }));
    expect(r.shape).toBe("working");
    expect(r.headline).toBe("3 runs are live, 2 items need a person and 1 run waits on a release decision.");
  });

  it("leaves a zero out of the sentence and uses the singular for one", () => {
    expect(projectShape(input({ liveRuns: 1 })).headline).toBe("1 run is live.");
    expect(projectShape(input({ items: [item()] })).headline).toBe("1 item needs a person.");
  });

  it("is working, never quiet, with only a run at the release gate", () => {
    const r = projectShape(input({ releaseRuns: 2 }));
    expect(r.shape).toBe("working");
    expect(r.headline).toBe("2 runs wait on a release decision.");
  });

  it("is working, never quiet, with issues Awaiting release and no run at the gate", () => {
    const r = projectShape(input({ releaseIssues: 5 }));
    expect(r.shape).toBe("working");
    expect(r.headline).toBe("5 issues await release.");
    expect(projectShape(input({ releaseIssues: 1 })).headline).toBe("1 issue awaits release.");
  });

  it("names the run at the gate rather than the issue behind it where both are counted", () => {
    expect(projectShape(input({ releaseRuns: 1, releaseIssues: 1 })).headline).toBe("1 run waits on a release decision.");
  });

  it("says at least where the attention list is cut, and is not quiet where it lists none of what it counts", () => {
    const r = projectShape(input({ items: [], cut: { shown: 0, atLeast: 3, peopleCut: true } }));
    expect(r.shape).toBe("working");
    expect(r.headline).toBe("At least 3 items need a person.");
    expect(projectShape(input({ items: [], cut: { shown: 0, atLeast: 1, peopleCut: true } })).headline).toBe(
      "At least 1 item needs a person.",
    );
  });
});

describe("a degraded project", () => {
  it("is degraded by a failed job, with a band naming it and one link to it", () => {
    const failed = item({ actionKind: "retry", link: "/projects/p/issues/f1", since: ago(3 * 3600) });
    const r = projectShape(input({ items: [failed] }));
    expect(r.shape).toBe("degraded");
    expect(r.band?.text).toBe("Work is failing — 1 failed job");
    expect(r.band?.entry).toEqual({ label: "Action needed — oldest item failed 3h", href: "/projects/p/issues/f1" });
  });

  it("is degraded by a failed job the response counts but the capped list does not show, offering the pipeline", () => {
    const r = projectShape(input({ failedJobs: 2 }));
    expect(r.shape).toBe("degraded");
    expect(r.band?.text).toBe("Work is failing — 2 failed jobs");
    expect(r.band?.entry).toEqual({ label: "Action needed — open the pipeline", href: "/projects/p/pipeline" });
  });

  it("takes no failed job from an attention read that did not arrive", () => {
    expect(projectShape(input({ attention: { read: "pending" }, failedJobs: 2 })).shape).toBe("unread");
  });

  it("turns degraded at fourteen days of a measured wait, and not a second before", () => {
    const at = (s: number) => projectShape(input({ items: [item({ since: ago(s) })] })).shape;
    expect(at(14 * DAY - 1)).toBe("working");
    expect(at(14 * DAY)).toBe("degraded");
  });

  it("never degrades on a last-write age, which is not time parked", () => {
    const old = item({ since: ago(112 * DAY), sinceBasis: "last-write" });
    expect(projectShape(input({ items: [old] })).shape).toBe("working");
  });

  it("links the oldest listed qualifying item, and says listed where the lists are cut", () => {
    const young = item({ key: "a", link: "/a", since: ago(15 * DAY) });
    const oldest = item({ key: "b", link: "/b", since: ago(112 * DAY) });
    const whole = projectShape(input({ items: [young, oldest] }));
    expect(whole.band?.entry).toEqual({ label: "Action needed — oldest item waiting 112d", href: "/b" });
    const cut = projectShape(input({ items: [young, oldest], cut: { shown: 2, atLeast: 9, peopleCut: true } }));
    expect(cut.band?.entry?.label).toBe("Action needed — oldest listed item waiting 112d");
  });

  it("is degraded by a stuck run and offers the pipeline", () => {
    const r = projectShape(input({ stuckRuns: [run({})] }));
    expect(r.shape).toBe("degraded");
    expect(r.band?.text).toBe("Work is blocked — 1 run stuck with no job running");
    expect(r.band?.entry).toEqual({ label: "Action needed — open the pipeline", href: "/projects/p/pipeline" });
  });

  it("words a failure and a block together", () => {
    const r = projectShape(input({ items: [item({ actionKind: "retry" })], stuckRuns: [run({})] }));
    expect(r.band?.text).toBe("Work is blocked and failing — 1 failed job · 1 run stuck with no job running");
  });

  it("holds a run stuck only after an hour with no job and no beat", () => {
    const at = (s: number) => stuckRuns([run({ startedAt: ago(s) })], NOW).length;
    expect(at(STUCK_RUN_SECONDS - 1)).toBe(0);
    expect(at(STUCK_RUN_SECONDS)).toBe(1);
    expect(stuckRuns([run({ startedAt: ago(5 * DAY), lastSessionBeatAt: ago(60) })], NOW)).toHaveLength(0);
  });
});

describe("a project whose reads have not all arrived", () => {
  it.each([
    ["pending attention", { attention: { read: "pending" } }],
    ["pending runs", { runs: { read: "pending" } }],
    ["pending parked ages", { parked: { read: "pending" } }],
  ] as const)("is unread with %s, never quiet and never counted", (_name, over) => {
    const r = projectShape(input(over as Partial<ShapeInput>));
    expect(r.shape).toBe("unread");
    expect(r.headline).toBe("Reading what is going on…");
    expect(r.headline).not.toMatch(/Nothing needs anyone/);
  });

  it("names which read failed, and why", () => {
    const r = projectShape(input({ parked: { read: "failed", reason: "Internal Server Error" } }));
    expect(r.shape).toBe("unread");
    expect(r.headline).toBe("Part of this page could not be read.");
    expect(r.unread).toEqual(["How long parked issues have waited could not be read: Internal Server Error"]);
  });

  it("states no item count from an attention read that failed", () => {
    const r = projectShape(input({ attention: { read: "failed", reason: "x" }, items: [item()], liveRuns: 2 }));
    expect(r.shape).toBe("unread");
    expect(r.headline).not.toMatch(/need/);
  });

  it("still shows a degraded reason proven by the reads that arrived", () => {
    const r = projectShape(input({ parked: { read: "pending" }, stuckRuns: [run({})] }));
    expect(r.shape).toBe("degraded");
    expect(r.unread).toEqual(["How long parked issues have waited is still being read."]);
  });

  it("draws no failed job from an attention read that did not arrive, and no stuck run from runs that did not", () => {
    const failed = item({ actionKind: "retry" });
    expect(projectShape(input({ attention: { read: "pending" }, items: [failed] })).shape).toBe("unread");
    expect(projectShape(input({ runs: { read: "pending" }, stuckRuns: [run({})] })).shape).toBe("unread");
  });
});

describe("an age's band", () => {
  it.each([
    [0, "fresh"],
    [DAY - 1, "fresh"],
    [DAY, "aging"],
    [3 * DAY - 1, "aging"],
    [3 * DAY, "stale"],
    [14 * DAY - 1, "stale"],
    [14 * DAY, "overdue"],
    [112 * DAY, "overdue"],
  ] as const)("%i seconds is %s", (seconds, band) => {
    expect(ageBand(seconds)).toBe(band);
  });
});

describe("the ages of parked issues", () => {
  const row = (over: Partial<IssueRow>) => ({ id: "d1", updatedAt: ago(5 * DAY), ...over }) as IssueRow;

  it("takes the open question's wait where there is one, measured", () => {
    const ages = parkedAges([row({ waitingOnPersonSince: ago(20 * DAY) })]);
    expect(ages.get("d1")).toEqual({ since: ago(20 * DAY), basis: "entered" });
  });

  it("falls back to the last write, said to be one", () => {
    expect(parkedAges([row({ waitingOnPersonSince: null })]).get("d1")).toEqual({ since: ago(5 * DAY), basis: "last-write" });
  });

  it("holds nothing for a row it never read", () => {
    expect(parkedAges(undefined).size).toBe(0);
  });
});

describe("a figure's comparison", () => {
  it("compares today's spend with the 7-day daily average", () => {
    expect(spendComparison(14, 49)).toBe("2.0× the 7-day daily average of $7.00");
  });

  it("states none where the week holds no spend", () => {
    expect(spendComparison(3, 0)).toBeNull();
  });

  const day = (n: number, count: number) => ({ projectId: "p", date: `2026-10-${String(n).padStart(2, "0")}`, count });
  it("compares the last day shipped with the six before it", () => {
    const week = [day(7, 1), day(8, 2), day(9, 3), day(10, 0), day(11, 2), day(12, 0), day(13, 4)];
    expect(throughputComparison(week)).toBe("4 today · 1.3 a day over the six before");
  });

  it("states none where the series is not seven days", () => {
    expect(throughputComparison([day(13, 4)])).toBeNull();
  });

  it("compares the slowest step with the next one, and states none for one step or a zero", () => {
    expect(slowestComparison([{ step: "test", medianSec: 840 }, { step: "code", medianSec: 300 }])).toEqual({
      step: "test",
      ratio: 2.8,
      next: "code",
    });
    expect(slowestComparison([{ step: "test", medianSec: 840 }])).toBeNull();
    expect(slowestComparison([{ step: "test", medianSec: 840 }, { step: "code", medianSec: 0 }])).toBeNull();
  });
});

describe("unreadStatement", () => {
  it("agrees its verb with what it names, and gives the reason where it is known", () => {
    expect(unreadStatement("The project's runs", { read: "pending" }, true)).toBe("The project's runs are still being read.");
    expect(unreadStatement("What needs you", { read: "pending" })).toBe("What needs you is still being read.");
    expect(unreadStatement("The project's runs", { read: "failed", reason: "Gateway Timeout" }, true)).toBe(
      "The project's runs could not be read: Gateway Timeout",
    );
  });

  it("says nothing of a read that is in", () => {
    expect(unreadStatement("The project's runs", { read: "ok" }, true)).toBeNull();
  });
});
