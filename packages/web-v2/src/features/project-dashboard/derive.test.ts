import { OPEN_WORK_STATES, WORK_STATE_LABELS } from "@forge/contracts/work-state";
import { describe, expect, it } from "vitest";
import {
  activeRuns,
  activeSpend,
  idleRuns,
  joblessRuns,
  spendByStep,
  type AttentionActionKind,
  attentionCaption,
  attentionCut,
  attentionRefusal,
  conicGradient,
  type DashboardAttentionItem,
  projectAttention,
  runnersSummary,
  statusDonut,
} from "./derive";
import type { AttentionItem, AttentionView } from "@/features/attention/types";
import type { PipelineRunListItem } from "@/features/runs/types";

const WORK = {
  open: 56,
  in_flight: 11,
  awaiting_release: 1,
  blocked_on_person: 4,
  draft: 24,
  finished: 1306,
};

describe("statusDonut (ISS-1156)", () => {
  it("draws a legend row for every open state that holds an issue, worded as the state is", () => {
    const { segments } = statusDonut(WORK);
    expect(segments.map((s) => [s.key, s.label, s.count])).toEqual([
      ["open", "Open, not picked up", 56],
      ["in_flight", "In flight", 11],
      ["awaiting_release", "Awaiting release", 1],
      ["blocked_on_person", "Blocked on a person", 4],
    ]);
  });

  it("adds the legend up to the figure at the ring's centre, so no slice is left unnamed", () => {
    const { segments, total } = statusDonut(WORK);
    expect(segments.reduce((n, s) => n + s.count, 0)).toBe(total);
    expect(total).toBe(72);
    expect(segments.reduce((n, s) => n + s.pct, 0)).toBeCloseTo(100, 6);
  });

  it("leaves drafts and finished work out of the ring and the figure, whatever their count", () => {
    const { segments, total } = statusDonut({ ...WORK, draft: 9999, finished: 9999 });
    expect(total).toBe(72);
    expect(segments.map((s) => s.key)).not.toContain("draft");
    expect(segments.map((s) => s.key)).not.toContain("finished");
  });

  it("leaves out a state with no issue in it rather than drawing an empty slice", () => {
    const { segments } = statusDonut({ ...WORK, awaiting_release: 0 });
    expect(segments.map((s) => s.key)).toEqual(["open", "in_flight", "blocked_on_person"]);
  });

  it("is empty, not zero-filled, for a project holding nothing open", () => {
    expect(statusDonut({ ...WORK, open: 0, in_flight: 0, awaiting_release: 0, blocked_on_person: 0 })).toEqual({
      segments: [],
      total: 0,
    });
    expect(statusDonut(undefined)).toEqual({ segments: [], total: 0 });
  });

  it("names its states with the words of the one vocabulary", () => {
    expect(statusDonut(WORK).segments.map((s) => s.label)).toEqual(
      OPEN_WORK_STATES.map((s) => WORK_STATE_LABELS[s]),
    );
  });

  it("colours every slice the ring draws, one stop per legend row", () => {
    const { segments } = statusDonut(WORK);
    const gradient = conicGradient(segments);
    for (const s of segments) expect(gradient).toContain(s.color);
  });
});

describe("attentionCaption (ISS-1156)", () => {
  const item = (actionKind: AttentionActionKind, i: number): DashboardAttentionItem => ({
    key: `${actionKind}-${i}`,
    actionKind,
    actionLabel: "x",
    title: "t",
    link: "/l",
  });

  it("says what the Needs you figure counts, by kind, so it is not read as Blocked on a person", () => {
    const items = [item("retry", 0), item("retry", 1), item("diff", 2), ...[3, 4, 5].map((i) => item("input", i)), item("parked", 6)];
    expect(attentionCaption(items)).toBe(
      "to act on: 2 failed jobs · 1 to review · 3 issues with an open question · 1 issue parked with no question",
    );
  });

  it("adds up to the figure: the parts of the caption are the items counted", () => {
    const items = [item("retry", 0), item("input", 1), item("input", 2)];
    const parts = attentionCaption(items).replace("to act on: ", "").split(" · ");
    expect(parts.reduce((n, p) => n + Number.parseInt(p, 10), 0)).toBe(items.length);
  });

  it("leaves out a kind with nothing in it, and says so when nothing needs a person", () => {
    expect(attentionCaption([item("diff", 0)])).toBe("to act on: 1 to review");
    expect(attentionCaption([])).toBe("nothing to act on");
  });
});

describe("projectAttention (ISS-1156)", () => {
  const awaiting = (n: number, questionId: string | null, status = "in_progress"): AttentionItem => ({
    kind: "awaiting_input",
    title: `Issue ${n}`,
    link: `/projects/sable/issues/doc-${n}`,
    since: "2026-10-08T00:00:00Z",
    issueRef: `ISS-${n}`,
    status,
    projectSlug: "sable",
    questionId,
  });
  const view = (awaitingInput: AttentionItem[]): AttentionView => ({
    needsReview: [],
    awaitingInput,
    mentions: [],
    failedJobs: [],
    pendingSkillUpdates: [],
    unseenDrafts: [],
    unseenDraftsTotal: 0,
    projectTotals: {},
    offlineRunners: [],
  });

  it("counts as a question only an issue that holds an open one, so the caption names what it counts", () => {
    const items = projectAttention(
      view([awaiting(1, "q1"), awaiting(2, "q2"), awaiting(3, null, "needs_info")]),
      "sable",
      [],
    );
    expect(items.filter((i) => i.actionKind === "input")).toHaveLength(2);
    expect(items.filter((i) => i.actionKind === "parked")).toHaveLength(1);
    expect(attentionCaption(items)).toBe(
      "to act on: 2 issues with an open question · 1 issue parked with no question",
    );
  });

  it("lists an issue once even where it is both holding a question and in the project's blockers", () => {
    const items = projectAttention(view([awaiting(1, "q1", "needs_info")]), "sable", [
      { issueId: "ISS-1", documentId: "doc-1", status: "needs_info" },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.actionKind).toBe("input");
  });

  it("words a parked issue in the work-state vocabulary, never with the raw status key", () => {
    const [item] = projectAttention(undefined, "sable", [
      { issueId: "ISS-9", documentId: "doc-9", status: "needs_info" },
    ]);
    expect(item?.title).toBe("Blocked on a person — Needs info");
    expect(item?.title).not.toContain("needs_info");
    const [hold] = projectAttention(undefined, "sable", [
      { issueId: "ISS-8", documentId: "doc-8", status: "on_hold" },
    ]);
    expect(hold?.title).toBe("Blocked on a person — On hold");
  });

  it("refuses a parked issue at a status the kernel does not have, by name, rather than word it by a guess", () => {
    expect(() =>
      projectAttention(undefined, "sable", [{ issueId: "ISS-3", documentId: "doc-3", status: "banana" }]),
    ).toThrow(/parked at `banana`.*not one of the issue statuses/u);
  });

  it("carries the time an attention item entered its state", () => {
    const [item] = projectAttention(view([awaiting(1, "q1")]), "sable", []);
    expect(item).toMatchObject({ since: "2026-10-08T00:00:00Z" });
  });

  it("ages a parked issue from the page's ages by its issue id, and lists one it has no age for without a time", () => {
    const ages = new Map([["doc-9", "2026-06-23T00:00:00Z"]]);
    const items = projectAttention(
      undefined,
      "sable",
      [
        { issueId: "ISS-9", documentId: "doc-9", status: "needs_info" },
        { issueId: "ISS-8", documentId: "doc-8", status: "on_hold" },
      ],
      ages,
    );
    expect(items[0]).toMatchObject({ since: "2026-06-23T00:00:00Z" });
    expect(items[1]?.since).toBeUndefined();
  });

  it("keeps another project's rows out", () => {
    const other = { ...awaiting(5, "q5"), projectSlug: "tern" };
    expect(projectAttention(view([other]), "sable", [])).toEqual([]);
  });
});

describe("attentionRefusal (ISS-1156)", () => {
  const view = (projectTotals: unknown): AttentionView =>
    ({
      needsReview: [],
      awaitingInput: [],
      mentions: [],
      failedJobs: [],
      pendingSkillUpdates: [],
      unseenDrafts: [],
      unseenDraftsTotal: 0,
      projectTotals,
      total: 0,
      offlineRunners: [],
    }) as AttentionView;

  it("names the field a response lacks, so the tile can say it where the figure would be", () => {
    expect(attentionRefusal(view(undefined), "sable")).toMatch(/no `projectTotals`.*not the release/u);
    expect(
      attentionRefusal(view({ sable: { needsReview: 0, awaitingInput: 1, failedJobs: 0 } }), "sable"),
    ).toMatch(/no `awaitingOutsideBlockers`/u);
  });

  it("says nothing of a response that carries both, a project with no entry, or one not loaded yet", () => {
    const ok = { needsReview: 0, awaitingInput: 1, awaitingOutsideBlockers: 1, failedJobs: 0 };
    expect(attentionRefusal(view({ sable: ok }), "sable")).toBeNull();
    expect(attentionRefusal(view({}), "sable")).toBeNull();
    expect(attentionRefusal(undefined, "sable")).toBeNull();
  });
});

describe("attentionCut (ISS-1156)", () => {
  const item = (actionKind: AttentionActionKind, i: number): DashboardAttentionItem => ({
    key: `${actionKind}-${i}`,
    actionKind,
    actionLabel: "x",
    title: "t",
    link: `/l/${i}`,
  });
  const many = (kind: AttentionActionKind, n: number) => Array.from({ length: n }, (_, i) => item(kind, i));
  const viewWith = (totals: {
    needsReview?: number;
    awaitingInput?: number;
    awaitingOutsideBlockers?: number;
    failedJobs?: number;
  }): AttentionView => ({
    needsReview: [],
    awaitingInput: [],
    mentions: [],
    failedJobs: [],
    pendingSkillUpdates: [],
    unseenDrafts: [],
    unseenDraftsTotal: 0,
    projectTotals: {
      sable: { needsReview: 0, awaitingInput: 0, awaitingOutsideBlockers: 0, failedJobs: 0, ...totals },
    },
    offlineRunners: [],
  });

  it("is null where every source's count is what the list holds", () => {
    const items = [...many("input", 3), ...many("parked", 2)];
    expect(attentionCut(items, viewWith({ awaitingInput: 3 }), "sable", 2)).toBeNull();
  });

  it("counts at least as many people as Open work counts blocked on one, whichever source listed them", () => {
    const items = many("input", 2);
    expect(attentionCut(items, viewWith({ awaitingInput: 2 }), "sable", 0, 5)).toEqual({ shown: 2, atLeast: 5, peopleCut: true });
    expect(attentionCut(items, viewWith({ awaitingInput: 2 }), "sable", 0, 2)).toBeNull();
    expect(attentionCut(items, viewWith({ awaitingInput: 2 }), "sable", 0)).toBeNull();
  });

  it("says 8 of at least 10 where 1 question and 9 parked read as 8 parked: the parked read stops at 5 and the questions at the viewer's 20", () => {
    // j3's seed: one issue with a question and nine at needs_info, 10 to act on. The question
    // source lists all ten (its cap is 20) but the viewer's other projects took 12 of the 20.
    const items = [...many("input", 1), ...many("parked", 7)];
    const cut = attentionCut(items, viewWith({ awaitingInput: 10, awaitingOutsideBlockers: 1 }), "sable", 9);
    expect(cut).toEqual({ shown: 8, atLeast: 10, peopleCut: true });
    expect(attentionCaption(items, cut)).toBe(
      "to act on: 1 issue with an open question · 7 issues parked with no question — 8 of at least 10",
    );
  });

  it("does not add an issue both sources hold twice: 6 awaiting, 5 of them at a status the parked list holds, 46 parked", () => {
    const items = many("parked", 5);
    expect(attentionCut(items, viewWith({ awaitingInput: 6, awaitingOutsideBlockers: 1 }), "sable", 46)?.atLeast).toBe(47);
  });

  it("counts the viewer's own waiting issue the cross-project list never reached, which the parked list never holds (j4's F1)", () => {
    // pair: ISS-4 waiting (the viewer's) is owed, ISS-2 on_hold and ISS-3 needs_info are parked and
    // listed, and the viewer's 20-item question list is all another project's, so nothing of ISS-4 is listed.
    const items = many("parked", 3);
    const cut = attentionCut(items, viewWith({ awaitingInput: 1, awaitingOutsideBlockers: 1 }), "sable", 3);
    expect(cut).toEqual({ shown: 3, atLeast: 4, peopleCut: true });
    expect(attentionCaption(items, cut)).toBe("to act on: 3 issues parked with no question — 3 of at least 4");
  });

  it("does not overstate where the unlisted question's issue is one the parked list already shows", () => {
    // one needs_info issue the viewer owns with a question: in both sources, listed from the parked one only.
    const items = many("parked", 1);
    expect(attentionCut(items, viewWith({ awaitingInput: 1, awaitingOutsideBlockers: 0 }), "sable", 1)).toBeNull();
  });

  it("holds the least that is true where the parked total is not loaded yet", () => {
    const items = many("input", 1);
    expect(attentionCut(items, viewWith({ awaitingInput: 4, awaitingOutsideBlockers: 4 }), "sable", undefined)?.atLeast).toBe(4);
  });

  it("adds a cut failed-jobs or review bucket to the people it lists", () => {
    const items = [...many("retry", 5), ...many("diff", 5), ...many("input", 2)];
    const cut = attentionCut(items, viewWith({ failedJobs: 8, needsReview: 6, awaitingInput: 2 }), "sable", 0);
    expect(cut).toEqual({ shown: 12, atLeast: 16, peopleCut: false });
  });

  it("does not link to the people it lists where only another bucket is cut", () => {
    const items = many("retry", 5);
    expect(attentionCut(items, viewWith({ failedJobs: 9 }), "sable", 0)?.peopleCut).toBe(false);
  });

  it("reads a project core has no totals for as holding nothing beyond its list", () => {
    expect(attentionCut(many("diff", 1), { ...viewWith({}), projectTotals: {} }, "sable", 0)).toBeNull();
  });

  it("refuses a response with no projectTotals, by name, rather than say the list is whole", () => {
    const old = { ...viewWith({}), projectTotals: undefined } as unknown as AttentionView;
    expect(() => attentionCut([], old, "sable", 0)).toThrow(/no `projectTotals`.*not the release/u);
  });

  it("refuses a response whose totals carry no awaitingOutsideBlockers, by name, since the two sources could then be counted twice", () => {
    const old = {
      ...viewWith({}),
      projectTotals: { sable: { needsReview: 0, awaitingInput: 2, failedJobs: 0 } },
    } as unknown as AttentionView;
    expect(() => attentionCut([], old, "sable", 1)).toThrow(/no `awaitingOutsideBlockers`.*not the release/u);
  });

  it("says nothing before the attention response has loaded", () => {
    expect(attentionCut([], undefined, "sable", 5)).toBeNull();
  });

  it("names an empty list that is cut as nothing listed rather than nothing to act on", () => {
    const cut = attentionCut([], viewWith({ awaitingInput: 3 }), "sable", 0);
    expect(attentionCaption([], cut)).toBe("nothing listed to act on — 0 of at least 3");
  });
});

describe("spendByStep — the kinds of work the rows name, in the Overview's words (ISS-1228)", () => {
  const row = (step: string, costUsd: number) => ({
    runId: "r",
    issueId: null,
    projectId: "p",
    step,
    startedAt: "2026-10-01T00:00:00Z",
    finishedAt: "2026-10-01T00:01:00Z",
    durationSeconds: 60,
    costUsd,
  });

  it("keeps each kind of work apart, costliest first, named as the Overview names it, in neutral ink", () => {
    const out = spendByStep([row("drive", 1), row("drive", 2), row("release_batch", 1)]);
    expect(out.total).toBe(4);
    expect(out.segments.map((s) => [s.key, s.label, s.cost, s.color])).toEqual([
      ["drive", "Issue work", 3, "var(--fg-default)"],
      ["release_batch", "Releases", 1, "var(--fg-muted)"],
    ]);
  });

  it("prints no stored step name for any kind the Overview names", () => {
    const out = spendByStep([row("reconcile", 3), row("pm", 2), row("smoke", 1)]);
    expect(out.segments.map((s) => s.label)).toEqual(["Skill updates", "Project manager", "Skill trial runs"]);
    expect(out.segments.some((s) => s.label.includes("_"))).toBe(false);
  });

  it("folds everything past the three costliest into Other", () => {
    const out = spendByStep([
      row("drive", 4),
      row("release_batch", 3),
      row("reconcile", 2),
      row("pm", 1),
      row("smoke", 0.5),
    ]);
    expect(out.segments.map((s) => s.label)).toEqual(["Issue work", "Releases", "Skill updates", "Other"]);
    expect(out.segments[3]?.cost).toBe(1.5);
  });

  it("says a step no kind of work names is unrecognised, keeping the name the row carries", () => {
    const out = spendByStep([row("code", 1)]);
    expect(out.segments.map((s) => [s.key, s.label])).toEqual([["code", "Unrecognised work (code)"]]);
    expect(out.segments.every((s) => !s.color.includes("stage"))).toBe(true);
  });

  it("returns no segment and a zero total for an empty or zero-cost window", () => {
    expect(spendByStep(undefined)).toEqual({ segments: [], total: 0 });
    expect(spendByStep([row("drive", 0)])).toEqual({ segments: [], total: 0 });
  });
});

describe("what works an open run: a live job or a session that has not ended", () => {
  const run = (id: string, over: Partial<PipelineRunListItem>) =>
    ({ id, status: "running", currentStep: null, liveJobs: 0, lastSessionBeatAt: null, cost: { estimatedCost: 1 }, ...over }) as PipelineRunListItem;
  const byJob = run("job", { liveJobs: 1 });
  const bySession = run("session", { lastSessionBeatAt: "2026-10-15T05:00:00Z" });
  const nothing = run("nothing", {});
  const atGate = run("gate", { currentStep: "tested" });
  const done = run("done", { status: "completed" as PipelineRunListItem["status"], liveJobs: 1 });
  const runs = [byJob, bySession, nothing, atGate, done];
  const ids = (rs: PipelineRunListItem[]) => rs.map((r) => r.id);

  it("counts a run its session works as worked, though no job is on it", () => {
    expect(ids(activeRuns(runs))).toEqual(["job", "session"]);
    expect(activeSpend(runs)).toBe(2);
  });

  it("calls idle only an open run off the release gate that neither works", () => {
    expect(ids(idleRuns(runs))).toEqual(["nothing"]);
  });

  it("keeps a session-worked run among the jobless, which is where a silent one goes stuck from", () => {
    expect(ids(joblessRuns(runs))).toEqual(["session", "nothing"]);
  });
});

describe("runnersSummary — a runner hosting a live session is busy (ISS-1228)", () => {
  const runner = (runnerId: string, deviceId: string, deviceStatus: "online" | "offline" = "online") => ({
    runnerId,
    deviceId,
    deviceName: runnerId,
    platform: "linux" as const,
    deviceStatus,
    runnerStatus: "enabled",
  });
  const runners = [runner("rn1", "dv1"), runner("rn2", "dv2"), runner("rn3", "dv3", "offline")] as never;
  const queue = { devices: [] } as never;

  it("counts the runner whose device hosts sessions, with no pool job on it", () => {
    const sum = runnersSummary(runners, queue, 0, [], [{ deviceId: "dv1" }, { deviceId: "dv1" }]);
    expect(sum.busyCount).toBe(1);
    expect(sum.onlineCount).toBe(2);
    expect(sum.lines.map((l) => [l.id, l.busy, l.sessions])).toEqual([
      ["rn1", true, 2],
      ["rn2", false, 0],
      ["rn3", false, 0],
    ]);
  });

  it("reads idle without the sessions, which is the reading the judge saw", () => {
    expect(runnersSummary(runners, queue, 0, []).busyCount).toBe(0);
  });

  it("counts busy only among the online runners the caption divides by", () => {
    const sum = runnersSummary(runners, queue, 0, [], [{ deviceId: "dv3" }]);
    expect(sum.lines.find((l) => l.id === "rn3")?.busy).toBe(true);
    expect(sum.busyCount).toBe(0);
  });

  it("ignores a session with no device", () => {
    expect(runnersSummary(runners, queue, 0, [], [{ deviceId: null }]).busyCount).toBe(0);
  });
});
