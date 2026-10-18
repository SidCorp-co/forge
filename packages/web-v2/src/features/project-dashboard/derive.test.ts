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
  attentionParts,
  attentionRefusal,
  attentionWhole,
  stuckLeftOut,
  stuckRowsOf,
  conicGradient,
  type DashboardAttentionItem,
  projectAttention,
  runnersSummary,
  sessionsWaitingOnYou,
  statusDonut,
} from "./derive";
import type { LiveSession } from "@/features/pipeline/types";
import type { AttentionItem, AttentionView } from "@/features/attention/types";
import type { PipelineRunListItem } from "@/features/runs/types";

/** The caption for a list core holds no totals for: its parts are the rows listed. */
const captionOf = (items: readonly DashboardAttentionItem[]) =>
  attentionCaption(attentionParts(items, undefined, "sable"));

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
    expect(captionOf(items)).toBe(
      "to act on: 2 failed jobs · 1 to review · 3 issues with an open question · 1 issue parked with no question",
    );
  });

  it("adds up to the figure: the parts of the caption are the items counted", () => {
    const items = [item("retry", 0), item("input", 1), item("input", 2)];
    const parts = captionOf(items).replace("to act on: ", "").split(" · ");
    expect(parts.reduce((n, p) => n + Number.parseInt(p, 10), 0)).toBe(items.length);
  });

  it("leaves out a kind with nothing in it, and says so when nothing needs a person", () => {
    expect(captionOf([item("diff", 0)])).toBe("to act on: 1 to review");
    expect(captionOf([])).toBe("nothing to act on");
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
    bucketTotals: { needsReview: 0, awaitingInput: 0, mentions: 0, failedJobs: 0, pendingSkillUpdates: 0, unseenDrafts: 0 },
    projectTotals: {},
    total: 0,
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
    expect(captionOf(items)).toBe(
      "to act on: 2 issues with an open question · 1 issue parked with no question",
    );
  });

  it("lists an issue once even where it is both holding a question and in the project's blockers", () => {
    const items = projectAttention(view([awaiting(1, "q1", "needs_info")]), "sable", [
      { issueId: "ISS-1", documentId: "doc-1", title: "Issue 1", status: "needs_info" },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.actionKind).toBe("input");
  });

  // ISS-1229 r13 repair 2: a parked row read "Blocked on a person — Waiting" where its title belonged.
  it("names a parked issue by its title, and why it is listed in the work-state vocabulary, never the raw status key", () => {
    const [item] = projectAttention(undefined, "sable", [
      { issueId: "ISS-9", documentId: "doc-9", title: "Production SMTP credentials", status: "needs_info" },
    ]);
    expect(item).toMatchObject({ title: "Production SMTP credentials", detail: "Blocked on a person — Needs info" });
    expect(item?.detail).not.toContain("needs_info");
    const [hold] = projectAttention(undefined, "sable", [
      { issueId: "ISS-8", documentId: "doc-8", title: "Issue 8", status: "on_hold" },
    ]);
    expect(hold?.detail).toBe("Blocked on a person — On hold");
    const [silent] = projectAttention(view([awaiting(3, null, "waiting")]), "sable", []);
    expect(silent).toMatchObject({ title: "Issue 3", detail: "Blocked on a person — Waiting" });
  });

  it("names a failed job's row by its issue's title, with what failed under it, and a job on no issue by what failed", () => {
    const failed = (issueTitle?: string): AttentionItem => ({
      kind: "failed_job",
      title: "drive failed: session_lost",
      jobType: issueTitle ? "drive" : "release_batch",
      failure: issueTitle ? "session_lost" : "runner_unreachable",
      link: "/projects/sable/issues/doc-4",
      since: "2026-10-08T00:00:00Z",
      status: "failed",
      projectSlug: "sable",
      ...(issueTitle ? { issueRef: "ISS-4", issueTitle } : {}),
    });
    // In the overview's words, never the stored codes (ISS-1229 r14).
    const [onIssue] = projectAttention({ ...view([]), failedJobs: [failed("Nightly stock import")] }, "sable", []);
    expect(onIssue).toMatchObject({ title: "Nightly stock import", detail: "Issue work failed: Session lost" });
    const [onNone] = projectAttention({ ...view([]), failedJobs: [failed()] }, "sable", []);
    expect(onNone?.title).toBe("Release failed: Runner unreachable");
    expect(onNone?.detail).toBeUndefined();
  });

  it("refuses a parked issue at a status the kernel does not have, by name, rather than word it by a guess", () => {
    expect(() =>
      projectAttention(undefined, "sable", [{ issueId: "ISS-3", documentId: "doc-3", title: "Issue 3", status: "banana" }]),
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
        { issueId: "ISS-9", documentId: "doc-9", title: "Issue 9", status: "needs_info" },
        { issueId: "ISS-8", documentId: "doc-8", title: "Issue 8", status: "on_hold" },
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
    }) as unknown as AttentionView;

  it("names the field a response lacks, so the tile can say it where the figure would be", () => {
    expect(attentionRefusal(view(undefined), "sable")).toMatch(/no `projectTotals`.*not the release/u);
    expect(
      attentionRefusal(view({ sable: { needsReview: 0, awaitingInput: 1, failedJobs: 0 } }), "sable"),
    ).toMatch(/no `parkedOnly`/u);
  });

  it("says nothing of a response that carries both, a project with no entry, or one not loaded yet", () => {
    const ok = { needsReview: 0, awaitingInput: 1, awaitingAsked: 0, parkedOnly: 1, failedJobs: 0, stuckOnly: 0 };
    expect(attentionRefusal(view({ sable: ok }), "sable")).toBeNull();
    expect(attentionRefusal(view({}), "sable")).toBeNull();
    expect(attentionRefusal(undefined, "sable")).toBeNull();
  });
});

describe("attentionCut (ISS-1156, whole since ISS-1229 r14)", () => {
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
    awaitingAsked?: number;
    parkedOnly?: number;
    failedJobs?: number;
    stuckOnly?: number;
  }): AttentionView => ({
    needsReview: [],
    awaitingInput: [],
    mentions: [],
    failedJobs: [],
    pendingSkillUpdates: [],
    unseenDrafts: [],
    unseenDraftsTotal: 0,
    bucketTotals: { needsReview: 0, awaitingInput: 0, mentions: 0, failedJobs: 0, pendingSkillUpdates: 0, unseenDrafts: 0 },
    projectTotals: {
      sable: {
        needsReview: 0,
        awaitingInput: 0,
        awaitingAsked: 0,
        parkedOnly: 0,
        failedJobs: 0,
        stuckOnly: 0,
        ...totals,
      },
    },
    total: 0,
    offlineRunners: [],
  });

  it("is null where every source's whole count is what the list holds", () => {
    const items = [...many("input", 3), ...many("parked", 2)];
    expect(attentionCut(items, viewWith({ awaitingInput: 3, parkedOnly: 2 }), "sable")).toBeNull();
  });

  it("says 25 of 32 for judge-35's 32 parks the reader owes, never at least 32", () => {
    // 20 parks listed from the reader's capped bucket and 5 more from the health row's parked list.
    const items = many("parked", 25);
    const cut = attentionCut(items, viewWith({ awaitingInput: 32 }), "sable");
    expect(cut).toEqual({ shown: 25, whole: 32, peopleCut: true });
  });

  // ISS-1229 r15: judge-38 read "to act on: 25 issues parked with no question — 25 of 32 listed" over
  // 32 parks, all of them with no question.
  it("counts every kind in the caption whole, listed or not, and never says how many are listed", () => {
    const items = many("parked", 25);
    const view = viewWith({ awaitingInput: 32 });
    const caption = attentionCaption(attentionParts(items, view, "sable"));
    expect(caption).toBe("to act on: 32 issues parked with no question");
    expect(caption).not.toMatch(/listed|of 32/u);
    expect(attentionWhole(items, view, "sable")).toBe(32);
  });

  it("splits the reader's parks by whether a question is open, from core's counts and not the rows", () => {
    const items = [...many("input", 2), ...many("parked", 3)];
    const view = viewWith({ awaitingInput: 30, awaitingAsked: 12, parkedOnly: 4 });
    expect(attentionCaption(attentionParts(items, view, "sable"))).toBe(
      "to act on: 12 issues with an open question · 22 issues parked with no question",
    );
    expect(attentionWhole(items, view, "sable")).toBe(34);
  });

  it("adds the parks someone else owes once, beside the reader's own", () => {
    // j4's shape: the reader owes 2, two more are parked by someone else and only the parked list holds them.
    const items = many("parked", 3);
    const cut = attentionCut(items, viewWith({ awaitingInput: 2, parkedOnly: 2 }), "sable");
    expect(cut).toEqual({ shown: 3, whole: 4, peopleCut: true });
  });

  it("adds a cut failed-jobs or review bucket to the people it lists", () => {
    const items = [...many("retry", 5), ...many("diff", 5), ...many("input", 2)];
    const cut = attentionCut(items, viewWith({ failedJobs: 8, needsReview: 6, awaitingInput: 2 }), "sable");
    expect(cut).toEqual({ shown: 12, whole: 16, peopleCut: false });
  });

  it("does not link to the people it lists where only another bucket is cut", () => {
    const items = many("retry", 5);
    expect(attentionCut(items, viewWith({ failedJobs: 9 }), "sable")?.peopleCut).toBe(false);
  });

  it("reads a project core has no totals for as holding nothing beyond its list", () => {
    expect(attentionCut(many("diff", 1), { ...viewWith({}), projectTotals: {} }, "sable")).toBeNull();
  });

  it("refuses a response with no projectTotals, by name, rather than say the list is whole", () => {
    const old = { ...viewWith({}), projectTotals: undefined } as unknown as AttentionView;
    expect(() => attentionCut([], old, "sable")).toThrow(/no `projectTotals`.*not the release/u);
  });

  it("refuses a response whose totals carry no parkedOnly, by name, since its whole could not be said", () => {
    const old = {
      ...viewWith({}),
      projectTotals: { sable: { needsReview: 0, awaitingInput: 2, failedJobs: 0 } },
    } as unknown as AttentionView;
    expect(() => attentionCut([], old, "sable")).toThrow(/no `parkedOnly`.*not the release/u);
  });

  it("says nothing before the attention response has loaded", () => {
    expect(attentionCut([], undefined, "sable")).toBeNull();
  });

  it("names what an empty list leaves out by kind, rather than nothing to act on", () => {
    const view = viewWith({ awaitingInput: 3 });
    expect(attentionCut([], view, "sable")).toEqual({ shown: 0, whole: 3, peopleCut: true });
    expect(attentionCaption(attentionParts([], view, "sable"))).toBe("to act on: 3 issues parked with no question");
  });

  it("refuses a response whose totals carry no stuckOnly, by name, since its whole could not be said", () => {
    const old = {
      ...viewWith({}),
      projectTotals: { sable: { needsReview: 0, awaitingInput: 2, awaitingAsked: 0, failedJobs: 0, parkedOnly: 0 } },
    } as unknown as AttentionView;
    expect(() => attentionCut([], old, "sable")).toThrow(/no `stuckOnly`.*not the release/u);
  });

  it("counts the stuck issues no other kind holds in the whole, and the stuck rows among what it shows", () => {
    const items = many("parked", 2);
    const view = viewWith({ awaitingInput: 2, stuckOnly: 12 });
    expect(attentionWhole(items, view, "sable", 5)).toBe(14);
    expect(attentionCut(items, view, "sable", 5)).toEqual({ shown: 7, whole: 14, peopleCut: false });
    expect(attentionCaption(attentionParts(items, view, "sable", 5))).toBe(
      "to act on: 2 issues parked with no question · 12 other issues reported stuck",
    );
  });
});

describe("the stuck issues Needs you shows (ISS-1229 r15)", () => {
  const parked = (n: number, stuckKind?: "waiting"): DashboardAttentionItem => ({
    key: `parked-${n}`,
    actionKind: "parked",
    actionLabel: "Open issue",
    title: `Issue ${n}`,
    issueRef: `ISS-${n}`,
    link: `/projects/sable/issues/doc-${n}`,
    ...(stuckKind ? { stuckKind } : {}),
  });
  const ref = (n: number, kind: "idle" | "orphan" | "waiting" = "idle") => ({
    issueId: `ISS-${n}`,
    documentId: `doc-${n}`,
    title: `Issue ${n}`,
    kind,
  });

  // judge-38's board: 14 stuck, ISS-11 and ISS-12 listed as parks, five refs that are not, seven nowhere.
  it("says 7 more where 7 of 14 are on the page, never 9", () => {
    const items = [parked(11, "waiting"), parked(12, "waiting")];
    const stuck = { total: 14, refs: [10, 9, 8, 4, 2].map((n) => ref(n)) };
    expect(stuckRowsOf(items, stuck).map((r) => r.issueId)).toEqual(["ISS-10", "ISS-9", "ISS-8", "ISS-4", "ISS-2"]);
    expect(stuckLeftOut(items, stuck)).toBe(7);
  });

  it("counts a stuck issue listed as an item once, whether or not the refs name it too", () => {
    const items = [parked(11, "waiting")];
    const stuck = { total: 3, refs: [ref(11, "waiting"), ref(2)] };
    expect(stuckRowsOf(items, stuck).map((r) => r.issueId)).toEqual(["ISS-2"]);
    expect(stuckLeftOut(items, stuck)).toBe(1);
  });

  it("leaves nothing out where every stuck issue is on the page", () => {
    expect(stuckLeftOut([], { total: 2, refs: [ref(1), ref(2)] })).toBe(0);
    expect(stuckLeftOut([], undefined)).toBe(0);
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

  it("names a step no kind of work names in its own words, keeping the name the row carries as its key", () => {
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

  // ISS-1228 round 14 (judge-36): a box still read Busy after every session on it stopped.
  it("calls a box busy only while it holds a live session, once the sessions are read", () => {
    const active = [{ runnerId: "rn2", name: "rn2", status: "online", lastSeenAt: null, current: { jobId: "j1" } }] as never;
    const sum = runnersSummary(runners, queue, 0, active, []);
    expect(sum.lines.find((l) => l.id === "rn2")?.busy).toBe(false);
    expect(sum.busyCount).toBe(0);
    // Before the sessions are read the job snapshot still answers.
    expect(runnersSummary(runners, queue, 0, active).lines.find((l) => l.id === "rn2")?.busy).toBe(true);
  });
});

// ISS-1228 round 9: a session its box reports blocked on a person is something a person has to act
// on, so Needs you counts it and lists it, in the box's own words; one blocked on anything else is not.
describe("sessions waiting on you", () => {
  const NOW = Date.parse("2026-10-16T10:00:00.000Z");
  const heard = new Date(NOW - 10_000).toISOString();
  const waitBegan = new Date(NOW - 35 * 60_000).toISOString();
  function session(over: Partial<LiveSession>): LiveSession {
    return {
      id: "s1",
      kind: "run_session",
      title: "run: ISS-3",
      status: "running",
      runtimeState: "working",
      deviceId: "d1",
      deviceName: "box-a",
      parentSessionId: null,
      startedAt: heard,
      lastHeartbeatAt: heard,
      createdAt: heard,
      issues: [{ issueId: "doc-3", displayId: "ISS-3", title: "Three" }],
      report: null,
      ...over,
    };
  }
  const blockedOn = (blockerKind: string) => ({
    incarnation: "live",
    work: "blocked",
    blockerKind,
    waitingOn: "approve the database restore",
    observedAt: heard,
    since: waitBegan,
  });

  it("lists a session blocked on a person, naming what it waits on and linking to its page", () => {
    const [item, ...rest] = sessionsWaitingOnYou([session({ report: blockedOn("human") })], "sable");
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      actionKind: "session",
      issueRef: "ISS-3",
      link: "/projects/sable/agents/s1",
      since: waitBegan,
    });
    expect(item?.title).toContain("approve the database restore");
  });

  it("ages the wait from when the box first reported it, not from its latest report (round 10)", () => {
    const [item] = sessionsWaitingOnYou([session({ report: blockedOn("human") })], "sable");
    expect(item?.since).toBe(waitBegan);
    expect(item?.since).not.toBe(heard);
  });

  it("does not list a session blocked on a machine, another agent or nobody, nor one working", () => {
    expect(
      sessionsWaitingOnYou(
        [
          session({ id: "a", report: blockedOn("machine") }),
          session({ id: "b", report: blockedOn("master_or_peer") }),
          session({ id: "c", report: blockedOn("nobody") }),
          session({ id: "d", report: { ...blockedOn("human"), work: "runnable" } }),
          session({ id: "e" }),
        ],
        "sable",
      ),
    ).toEqual([]);
  });

  it("counts it in the Needs you caption and in how much the list holds", () => {
    const items = sessionsWaitingOnYou([session({ report: blockedOn("human") })], "sable");
    expect(captionOf(items)).toBe("to act on: 1 session waiting on you");
    const view: AttentionView = {
      needsReview: [],
      awaitingInput: [],
      mentions: [],
      failedJobs: [],
      pendingSkillUpdates: [],
      unseenDrafts: [],
      unseenDraftsTotal: 0,
      projectTotals: {
        sable: { needsReview: 0, awaitingInput: 1, awaitingAsked: 0, parkedOnly: 0, failedJobs: 0, stuckOnly: 0 },
      },
      offlineRunners: [],
    } as unknown as AttentionView;
    // One person is owed an answer the list did not reach: the session listed beside it does not
    // stand in for that person, so the list says it holds one of two.
    expect(attentionCut(items, view, "sable")).toEqual({ shown: 1, whole: 2, peopleCut: true });
  });
});
