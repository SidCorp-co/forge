// What the project is doing, read from the reads the page holds (ISS-1159). Each boundary the shape
// turns on is pinned by a case that fails without it: the fourteen-day line, zero, an unread answer.

import { describe, expect, it } from "vitest";
import type { IssueRow } from "@/features/issues/types";
import type { PipelineRunListItem } from "@/features/runs/types";
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
  ...over,
});

const input = (over: Partial<ShapeInput> = {}): ShapeInput => ({
  attention: { read: "ok" },
  runs: { read: "ok" },
  sessions: { read: "ok" },
  parked: { read: "ok" },
  items: [],
  cut: null,
  slug: "p",
  liveSessions: 0,
  stuckRuns: [],
  failedJobs: 0,
  releaseRuns: 0,
  releaseIssues: 0,
  stuck: { read: "ok" },
  stuckIssues: 0,
  stuckIssuesByKind: {},
  stuckIssueRefs: [],
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
    const r = projectShape(input({ liveSessions: 3, items: [item(), item({ key: "k2" })], releaseRuns: 1 }));
    expect(r.shape).toBe("working");
    expect(r.headline).toBe("3 sessions are live, 2 items need a person and 1 run waits on a release decision.");
  });

  it("leaves a zero out of the sentence and uses the singular for one", () => {
    expect(projectShape(input({ liveSessions: 1 })).headline).toBe("1 session is live.");
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

  it("says the whole count where the attention list is cut, and is not quiet where it lists none of it", () => {
    const r = projectShape(input({ items: [], cut: { shown: 0, whole: 3, peopleCut: true } }));
    expect(r.shape).toBe("working");
    expect(r.headline).toBe("3 items need a person.");
    expect(projectShape(input({ items: [], cut: { shown: 0, whole: 1, peopleCut: true } })).headline).toBe(
      "1 item needs a person.",
    );
    // judge-35's 32 parks: the headline says 32, never "at least 32" (ISS-1229 r14).
    expect(projectShape(input({ items: [], cut: { shown: 25, whole: 32, peopleCut: true } })).headline).toBe(
      "32 items need a person.",
    );
  });
});

describe("a degraded project", () => {
  it("is degraded by a failed job, with a band naming it and one link to it", () => {
    const failed = item({ actionKind: "retry", link: "/projects/p/issues/f1", since: ago(3 * 3600) });
    const r = projectShape(input({ items: [failed] }));
    expect(r.shape).toBe("degraded");
    expect(r.band?.text).toBe("1 job failed.");
    expect(r.band?.entry).toEqual({ label: "Action needed — oldest item failed 3h", href: "/projects/p/issues/f1" });
  });

  it("is degraded by a failed job the response counts but the capped list does not show, offering the runs", () => {
    const r = projectShape(input({ failedJobs: 2 }));
    expect(r.shape).toBe("degraded");
    expect(r.band?.text).toBe("2 jobs failed.");
    expect(r.band?.entry).toEqual({ label: "Action needed — open the runs", href: "/projects/p/agents" });
  });

  it("takes no failed job from an attention read that did not arrive", () => {
    expect(projectShape(input({ attention: { read: "pending" }, failedJobs: 2 })).shape).toBe("unread");
  });

  it("turns degraded at fourteen days of a measured wait, and not a second before", () => {
    const at = (s: number) => projectShape(input({ items: [item({ since: ago(s) })] })).shape;
    expect(at(14 * DAY - 1)).toBe("working");
    expect(at(14 * DAY)).toBe("degraded");
  });

  it("links the oldest listed qualifying item, and says listed where the lists are cut", () => {
    const young = item({ key: "a", link: "/a", since: ago(15 * DAY) });
    const oldest = item({ key: "b", link: "/b", since: ago(112 * DAY) });
    const whole = projectShape(input({ items: [young, oldest] }));
    expect(whole.band?.entry).toEqual({ label: "Action needed — oldest item waiting 112d", href: "/b" });
    const cut = projectShape(input({ items: [young, oldest], cut: { shown: 2, whole: 9, peopleCut: true } }));
    expect(cut.band?.entry?.label).toBe("Action needed — oldest listed item waiting 112d");
  });

  it("is degraded by a stuck run and offers the runs, which the Pipeline page no longer lists", () => {
    const r = projectShape(input({ stuckRuns: [run({})] }));
    expect(r.shape).toBe("degraded");
    expect(r.band?.text).toBe("1 run has not been heard from for an hour.");
    expect(r.band?.entry).toEqual({ label: "Action needed — open the runs", href: "/projects/p/agents" });
  });

  it("says a failed job and a stuck run each in a sentence of its own", () => {
    const r = projectShape(input({ items: [item({ actionKind: "retry" })], stuckRuns: [run({})] }));
    expect(r.band?.text).toBe("1 job failed. 1 run has not been heard from for an hour.");
  });

  it("holds a run stuck only after an hour with no job and no beat", () => {
    const at = (s: number) => stuckRuns([run({ startedAt: ago(s) })], NOW).length;
    expect(at(STUCK_RUN_SECONDS - 1)).toBe(0);
    expect(at(STUCK_RUN_SECONDS)).toBe(1);
    expect(stuckRuns([run({ startedAt: ago(5 * DAY), lastSessionBeatAt: ago(60) })], NOW)).toHaveLength(0);
  });
});

describe("a project with stuck issues (ISS-1229 r12)", () => {
  const ISS_3 = { issueId: "ISS-3", documentId: "d-3", kind: "idle" as const };
  const ISS_9 = { issueId: "ISS-9", documentId: "d-9", kind: "waiting" as const };

  it("is degraded, never quiet, by one issue a stuck-issue notice stands for, and opens that issue", () => {
    const r = projectShape(input({ stuckIssues: 1, stuckIssueRefs: [ISS_3] }));
    expect(r.shape).toBe("degraded");
    expect(r.headline).toBe("1 issue is reported stuck.");
    expect(r.band?.entry).toEqual({ label: "Action needed — open ISS-3", href: "/projects/p/issues/d-3" });
  });

  it("counts two in the plural and opens the one stuck longest", () => {
    const r = projectShape(input({ stuckIssues: 2, stuckIssueRefs: [ISS_3, ISS_9] }));
    expect(r.headline).toBe("2 issues are reported stuck.");
    expect(r.band?.entry).toEqual({
      label: "Action needed — open ISS-3, stuck longest",
      href: "/projects/p/issues/d-3",
    });
  });

  it("claims no more than a standing notice establishes: never that nothing is working the issue", () => {
    const r = projectShape(input({ stuckIssues: 1, stuckIssueRefs: [ISS_3] }));
    expect(r.headline).not.toMatch(/nothing working/);
  });

  it("opens the issue list where the count names no issue", () => {
    const r = projectShape(input({ stuckIssues: 1, stuckIssueRefs: [] }));
    expect(r.band?.entry).toEqual({ label: "Action needed — open the issues", href: "/projects/p/issues" });
  });

  // ISS-1229 r13: the headline counts by what each notice says, in the words the bell titles each
  // kind's group with, so the headline, the bell and Attention reconcile on sight.
  it("says each kind of stuck issue in its own counted sentence, in the bell's words", () => {
    const r = projectShape(
      input({
        stuckIssues: 6,
        stuckIssuesByKind: { waiting: 3, idle: 2, owed_close: 1 },
        stuckIssueRefs: [ISS_9, ISS_3],
      }),
    );
    expect(r.headline).toBe(
      "3 issues have been waiting for you for over six hours. 2 issues are in a live status with no live work behind them. 1 issue shipped its code and was never closed.",
    );
  });

  // ISS-1229 r16, the master's ruling on criterion 98: "you" only of the parks the reader owes; the
  // ones somebody else owes are counted and worded apart.
  it("counts the parks the reader owes apart from the ones other people owe", () => {
    const r = projectShape(
      input({
        stuckIssues: 4,
        stuckIssuesByKind: { waiting: 2, waiting_on_others: 2 },
        stuckIssueRefs: [ISS_9, ISS_3],
      }),
    );
    expect(r.headline).toBe(
      "2 issues have been waiting for you for over six hours. 2 issues have been waiting for other people for over six hours.",
    );
  });

  it("says one of a kind in the singular", () => {
    const r = projectShape(input({ stuckIssues: 2, stuckIssuesByKind: { waiting: 1, orphan: 1 }, stuckIssueRefs: [ISS_9] }));
    expect(r.headline).toBe(
      "1 issue has been waiting for you for over six hours. 1 issue asserts work in progress with no run behind it.",
    );
  });

  it("says a failed job and stuck issues each in a sentence of its own", () => {
    const r = projectShape(input({ failedJobs: 1, stuckIssues: 3, stuckIssueRefs: [ISS_3] }));
    expect(r.headline).toBe("1 job failed. 3 issues are reported stuck.");
  });

  it("is unread, never quiet, where the stuck-issue count did not arrive", () => {
    const r = projectShape(input({ stuck: { read: "failed", reason: "no row" } }));
    expect(r.shape).toBe("unread");
    expect(r.headline).not.toMatch(/Nothing needs anyone/);
    expect(r.unread).toEqual(["The stuck-issue count could not be read: no row"]);
  });
});

describe("a project whose reads have not all arrived", () => {
  it.each([
    ["pending attention", { attention: { read: "pending" } }],
    ["pending runs", { runs: { read: "pending" } }],
    ["pending live sessions", { sessions: { read: "pending" } }],
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
    const r = projectShape(input({ attention: { read: "failed", reason: "x" }, items: [item()], liveSessions: 2 }));
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
  const row = (over: Partial<IssueRow>) =>
    ({ id: "d1", statusEnteredAt: ago(9 * DAY), updatedAt: ago(5 * DAY), ...over }) as IssueRow;

  it("takes the open question's wait where there is one", () => {
    const ages = parkedAges([row({ waitingOnPersonSince: ago(20 * DAY) })]);
    expect(ages.get("d1")).toBe(ago(20 * DAY));
  });

  // ISS-1229 r8: an edit to a parked issue wrote the row and restarted the chip's count.
  it("takes when the issue entered its status otherwise, never its last write", () => {
    expect(parkedAges([row({ waitingOnPersonSince: null })]).get("d1")).toBe(ago(9 * DAY));
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
