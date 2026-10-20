// @vitest-environment jsdom
//
// ISS-1228 — the Agents runs tab lists what the boxes report running. Where they report none, it says
// no run is working rather than that the project has no runs, and lists the runs that have closed.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineRunListItem } from "@/features/runs/types";
import type { RunSessionRow } from "../types";
import { RunsPane } from "./runs-pane";

expect.extend(matchers);

const state = vi.hoisted(() => ({
  rooms: [] as unknown[],
  runs: [] as unknown[],
  total: 0,
  ledger: [] as unknown[],
  failed: false,
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/projects/qa/agents" }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: (room: unknown) => state.rooms.push(room) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("../hooks", () => ({
  useRunSessions: () => ({
    data: { items: state.ledger, count: state.ledger.length },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/features/runs/hooks", () => ({
  useProjectRuns: () => ({
    data: state.failed ? undefined : { items: state.runs, totalCount: state.total },
    isLoading: false,
    isError: state.failed,
    error: null,
    refetch: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  state.runs = [];
  state.total = 0;
  state.ledger = [];
  state.failed = false;
});

const run = (over: Partial<PipelineRunListItem>): PipelineRunListItem =>
  ({
    id: "r",
    projectId: "p1",
    issueId: "i1",
    lane: "job",
    group: { source: "none", issues: [], detail: "a job-lane run carries its one issue in its own column, not a group" },
    issueRef: "ISS-1",
    issueTitle: "first",
    kind: "issue",
    status: "completed",
    currentStep: null,
    startedAt: "2026-10-14T08:00:00.000Z",
    finishedAt: "2026-10-14T09:00:00.000Z",
    cost: { estimatedCost: 0 },
    liveJobs: 0,
    lastSessionBeatAt: null,
    reading: null,
    ...over,
  }) as PipelineRunListItem;

const pane = () => render(<RunsPane scope={{ projectId: "p1", slug: "qa" }} />);

describe("the Agents runs tab with nothing running on a box", () => {
  it("says no run is working and lists every closed run, each linking to its issue", () => {
    state.runs = [
      run({ id: "a", issueId: "i1", issueRef: "ISS-1", status: "completed", finishedAt: "2026-10-14T09:00:00.000Z" }),
      run({ id: "b", issueId: "i2", issueRef: "ISS-2", status: "failed", finishedAt: "2026-10-15T09:00:00.000Z" }),
      run({ id: "c", issueId: "i3", issueRef: "ISS-3", status: "cancelled", finishedAt: "2026-10-13T09:00:00.000Z" }),
      run({ id: "d", issueId: "i4", issueRef: "ISS-4", status: "completed", finishedAt: "2026-10-12T09:00:00.000Z" }),
    ];
    state.total = 4;
    pane();
    expect(screen.queryByText("No runs on this project")).not.toBeInTheDocument();
    expect(screen.getByText("No run is working on this project right now.")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Closed runs" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => within(r).getByRole("link").textContent)).toEqual(["ISS-2", "ISS-1", "ISS-3", "ISS-4"]);
    expect(within(rows[0] as HTMLElement).getByRole("link")).toHaveAttribute("href", "/projects/qa/issues/i2");
    expect(rows.map((r) => (r.querySelector("[data-run-status]") as HTMLElement).textContent)).toEqual([
      "Failed",
      "Completed",
      "Stopped",
      "Completed",
    ]);
  });

  // Round 12: at 390 some rows dropped the age to a line of its own and others did not. Every row
  // holds its outcome and age in one unbreakable block beside what the run worked.
  it("keeps every closed run's outcome and age together on one line, whatever the run worked", () => {
    state.runs = [
      run({ id: "a", issueTitle: "a title long enough to wrap twice at a phone's width, and then some more" }),
      run({ id: "b", issueId: null, issueRef: null, issueTitle: null, kind: "pm" }),
    ];
    state.total = 2;
    pane();
    for (const row of within(screen.getByRole("list", { name: "Closed runs" })).getAllByRole("listitem")) {
      const outcome = row.querySelector("[data-run-outcome]") as HTMLElement;
      expect(outcome.className).toMatch(/\bflex-none\b/);
      expect(outcome.className).toMatch(/\bwhitespace-nowrap\b/);
      expect(outcome.querySelector("[data-run-status]")).not.toBeNull();
      expect(outcome).toHaveTextContent(/ago$/);
      expect(row.className).not.toMatch(/flex-wrap/);
    }
  });

  it("leaves an open run out of the closed list", () => {
    state.runs = [run({ id: "o", status: "running", finishedAt: null }), run({ id: "c", issueRef: "ISS-9" })];
    state.total = 2;
    pane();
    const rows = within(screen.getByRole("list", { name: "Closed runs" })).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("ISS-9");
  });

  it("names a closed run with no issue by its kind", () => {
    state.runs = [run({ id: "pm", issueId: null, issueRef: null, issueTitle: null, kind: "pm" })];
    state.total = 1;
    pane();
    const row = within(screen.getByRole("list", { name: "Closed runs" })).getByRole("listitem");
    expect(row).toHaveTextContent("Project manager run");
  });

  it("says the closed list is the newest of more when the read holds fewer runs than the project has", () => {
    state.runs = [run({ id: "a" }), run({ id: "b", issueRef: "ISS-2" })];
    state.total = 250;
    pane();
    expect(screen.getByText(/the newest 2 of 250 runs/)).toBeInTheDocument();
  });

  it("does not say no run is working while an open run has a live job behind it", () => {
    state.runs = [
      run({ id: "o", status: "running", finishedAt: null, liveJobs: 1 }),
      run({ id: "c", issueRef: "ISS-9" }),
    ];
    state.total = 2;
    pane();
    expect(screen.queryByText("No run is working on this project right now.")).not.toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Closed runs" })).getAllByRole("listitem")).toHaveLength(1);
  });

  // ISS-1228 r20 (after-shots): a run waiting on its question's answer is not over; it lists with
  // the open runs in the word its drawer reads, and an answered one closes as Answered.
  it("lists a run whose question stands as open, reading Needs an answer, and an answered one as Answered", () => {
    state.runs = [
      run({ id: "a", issueRef: "ISS-4", status: "failed", reading: "asking" }),
      run({ id: "b", issueRef: "ISS-5", status: "failed", reading: "answered" }),
    ];
    state.total = 2;
    pane();
    const open = within(screen.getByRole("list", { name: "Open runs" })).getAllByRole("listitem");
    expect(open.map((r) => (r.querySelector("[data-run-status]") as HTMLElement).textContent)).toEqual([
      "Needs an answer",
    ]);
    const closed = within(screen.getByRole("list", { name: "Closed runs" })).getAllByRole("listitem");
    expect(closed.map((r) => (r.querySelector("[data-run-status]") as HTMLElement).textContent)).toEqual(["Answered"]);
  });

  // ISS-1228 round 17 (judge-47): "No box reports a run here" stood above three open runs.
  it("says no box reports a run only where it lists no open run", () => {
    state.runs = [run({ id: "o", status: "running", finishedAt: null, liveJobs: 1, reading: "starting" })];
    state.total = 1;
    pane();
    expect(screen.getByRole("list", { name: "Open runs" })).toBeInTheDocument();
    expect(screen.queryByText(/No box reports a run/)).not.toBeInTheDocument();
  });

  // ISS-1228 round 17 (judge-47): an untaken, a taken and a sent run all read Running here while the
  // Ops drawer read Queued; each reads the word core gives it, the drawer's word.
  it("reads each open run by what core says its agent is doing", () => {
    state.runs = [
      run({ id: "q", issueRef: "ISS-1", status: "running", finishedAt: null, liveJobs: 1, reading: "queued" }),
      run({ id: "s", issueRef: "ISS-2", status: "running", finishedAt: null, liveJobs: 1, reading: "starting" }),
      run({ id: "r", issueRef: "ISS-3", status: "running", finishedAt: null, liveJobs: 1, reading: "running" }),
    ];
    state.total = 3;
    pane();
    const open = within(screen.getByRole("list", { name: "Open runs" })).getAllByRole("listitem");
    expect(open.map((r) => (r.querySelector("[data-run-status]") as HTMLElement).textContent)).toEqual([
      "Queued",
      "Starting",
      "Running",
    ]);
    // The master's read of the r17 shots: "Started 10m ago" beside a run nothing had started.
    expect(open.map((r) => (r.querySelector("[data-run-since]") as HTMLElement).textContent)).toEqual([
      expect.stringMatching(/^Opened .+ ago$/),
      expect.stringMatching(/^Opened .+ ago$/),
      expect.stringMatching(/^Started .+ ago$/),
    ]);
  });

  // ISS-1228 round 14 (judge-36): the tab counted an open run with work behind it and listed none.
  // Round 18 repair: the band named ISS-5 as having nothing working on it while the list left it out.
  it("lists every open run, one nothing works reading Nothing working, so the band names only listed runs", () => {
    state.runs = [
      run({ id: "o", issueRef: "ISS-4", issueTitle: "fourth", status: "running", finishedAt: null, liveJobs: 1 }),
      run({ id: "idle", issueRef: "ISS-5", status: "running", finishedAt: null }),
      run({ id: "c", issueRef: "ISS-9" }),
    ];
    state.total = 3;
    pane();
    const open = within(screen.getByRole("list", { name: "Open runs" })).getAllByRole("listitem");
    expect(open.map((r) => [r.querySelector("a")?.textContent, r.querySelector("[data-run-status]")?.textContent])).toEqual([
      ["ISS-4", "Running"],
      ["ISS-5", "Nothing working"],
    ]);
    expect(open[0]).toHaveTextContent("fourth");
    expect(within(open[0] as HTMLElement).getByRole("link", { name: "ISS-4" })).toHaveAttribute(
      "href",
      "/projects/qa/issues/i1",
    );
    expect(within(screen.getByText(/has nothing working on it/)).getByRole("link")).toHaveTextContent("ISS-5");
    // Criterion 141: a run says Started only once something runs; nothing runs this one.
    expect(open[1]?.querySelector("[data-run-since]")?.textContent).toMatch(/^Opened .+ ago$/);
    expect(open[0]?.querySelector("[data-run-since]")?.textContent).toMatch(/^Started .+ ago$/);
  });

  it("claims no run is working only off a whole reading of the project's runs", () => {
    state.runs = [run({ id: "a" }), run({ id: "b", issueRef: "ISS-2" })];
    state.total = 250;
    pane();
    expect(screen.queryByText("No run is working on this project right now.")).not.toBeInTheDocument();
    expect(screen.getByText("No box reports a run on this project right now.")).toBeInTheDocument();
  });

  it("claims nothing about the project's runs when they could not be read", () => {
    state.failed = true;
    pane();
    expect(screen.queryByText("No run is working on this project right now.")).not.toBeInTheDocument();
    expect(screen.queryByText("No runs on this project")).not.toBeInTheDocument();
    expect(screen.getByText("No box reports a run on this project right now.")).toBeInTheDocument();
    expect(screen.getByText(/Couldn.t read this project.s runs/)).toBeInTheDocument();
  });

  it("says the project has no runs only when the project has none at all", () => {
    pane();
    expect(screen.getByText("No runs on this project")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Closed runs" })).not.toBeInTheDocument();
  });
});

describe("a closed run a box opened over issues (ISS-1228 criterion 37)", () => {
  it("names each issue it was opened over, linking to its page, rather than calling it a System run", () => {
    state.runs = [
      run({
        id: "rs",
        issueId: null,
        issueRef: null,
        issueTitle: null,
        kind: "system",
        lane: "run_session",
        group: { source: "run_group", issues: ["ISS-1", "ISS-4"], detail: null },
        status: "completed",
      }),
    ];
    state.total = 1;
    pane();
    const list = screen.getByRole("list", { name: "Closed runs" });
    expect(within(list).getByRole("link", { name: "ISS-1" })).toHaveAttribute("href", "/projects/qa/issues/ISS-1");
    expect(within(list).getByRole("link", { name: "ISS-4" })).toHaveAttribute("href", "/projects/qa/issues/ISS-4");
    expect(within(list).queryByText("System run")).not.toBeInTheDocument();
  });

  // Round 12: judge-31 read "ISS-2 Completed" here while a job run beside it named its issue's title.
  it("shows each issue's title beside its key, as a job run does", () => {
    state.runs = [
      run({
        id: "rs",
        issueId: null,
        issueRef: null,
        issueTitle: null,
        kind: "system",
        lane: "run_session",
        group: { source: "run_group", issues: ["ISS-2", "ISS-3"], detail: null },
        groupTitles: { "ISS-2": "j31 bravo", "ISS-3": "j31 charlie" },
      }),
    ];
    state.total = 1;
    pane();
    const row = within(screen.getByRole("list", { name: "Closed runs" })).getByRole("listitem");
    for (const [key, title] of [["ISS-2", "j31 bravo"], ["ISS-3", "j31 charlie"]]) {
      const link = within(row).getByRole("link", { name: key as string });
      expect(link.parentElement).toHaveTextContent(`${key}${title}`);
    }
  });

  it("still names the kind of a closed run that carries no issue and no group", () => {
    state.runs = [
      run({
        id: "sys",
        issueId: null,
        issueRef: null,
        issueTitle: null,
        kind: "system",
        lane: "system",
        group: { source: "none", issues: [], detail: "this run was not opened over a group of issues" },
      }),
    ];
    state.total = 1;
    pane();
    expect(within(screen.getByRole("list", { name: "Closed runs" })).getByText("System run")).toBeInTheDocument();
  });
});

/** A run a box reports, as the ledger read returns it. */
const ledgerRow = (over: Partial<RunSessionRow>): RunSessionRow => ({
  runId: "lr1",
  projectId: "p1",
  sessionId: "s1",
  masterSessionId: null,
  pid: 4242,
  worktreePath: "/w/iss-1",
  bootId: "b1",
  incarnation: "live",
  work: "runnable",
  blockerKind: null,
  waitingOn: null,
  sessionTerminalAt: null,
  worktreeGoneAt: null,
  issues: [{ issueKey: "ISS-1", leaseReturned: false }],
  deviceId: "d1",
  deviceName: "box-a",
  observedAt: new Date().toISOString(),
  sessionStatus: "running",
  sessionFailureReason: null,
  lastActivityAt: new Date().toISOString(),
  masterTitle: null,
  ...over,
});

describe("the runs a box reports (ISS-1228 round 8)", () => {
  // ISS-1228 round 18 repair: a run the band names must be a row somewhere on the tab, whatever a box
  // reports for the same issue.
  it("lists every open run nothing works beside the runs boxes report, each reading Nothing working", () => {
    state.ledger = [ledgerRow({ issues: [{ issueKey: "ISS-1", leaseReturned: false }] })];
    const idle = { status: "running" as const, finishedAt: null, liveJobs: 0 };
    state.runs = [run({ ...idle, id: "r1", issueRef: "ISS-1" }), run({ ...idle, id: "r5", issueRef: "ISS-5" })];
    state.total = 2;
    pane();
    const rows = within(screen.getByRole("list", { name: "Open runs" })).getAllByRole("listitem");
    expect(rows.map((r) => [r.querySelector("a")?.textContent, r.querySelector("[data-run-status]")?.textContent])).toEqual([
      ["ISS-1", "Nothing working"],
      ["ISS-5", "Nothing working"],
    ]);
    const band = screen.getByText(/have nothing working on them/);
    expect(within(band).getAllByRole("link").map((a) => a.textContent)).toEqual(["ISS-1", "ISS-5"]);
  });

  it("filters the runs nothing works as it filters the runs boxes report", () => {
    state.ledger = [ledgerRow({ issues: [{ issueKey: "ISS-1", leaseReturned: false }] })];
    state.runs = [run({ id: "r5", issueRef: "ISS-5", issueTitle: "fifth", status: "running", finishedAt: null, liveJobs: 0 })];
    state.total = 1;
    pane();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter runs" }), { target: { value: "fifth" } });
    expect(screen.queryByRole("list", { name: "Runs a box reports" })).toBeNull();
    expect(within(screen.getByRole("list", { name: "Open runs" })).getByText("ISS-5")).toBeInTheDocument();
    expect(screen.queryByText("No runs match")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter runs" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Working" }));
    expect(screen.queryByRole("list", { name: "Open runs" })).toBeNull();
  });

  it("shows what a blocked run waits on in the box's own words", () => {
    state.ledger = [
      ledgerRow({ work: "blocked", blockerKind: "human", waitingOn: "approve the database restore in Coolify" }),
    ];
    pane();
    const row = within(screen.getByRole("list", { name: "Runs a box reports" })).getByRole("listitem");
    expect(row).toHaveTextContent("Waiting on a person. Approve the database restore in Coolify.");
    expect(row).not.toHaveTextContent(/read the decision/);
    // Round 16 (judge-42): the chip's hover said a machine or another agent held this wait.
    expect(within(row).getByText("Blocked").closest("[title]")).toHaveAttribute(
      "title",
      "It waits on a person, and keeps its process while it waits.",
    );
  });

  // ISS-1228 round 17 (judge-45): a blocked run whose box named no kind drew no wait, only a hover.
  it("shows the wait of a blocked run whose box named no blocker kind, the holder its hover names", () => {
    state.ledger = [ledgerRow({ work: "blocked", blockerKind: null, waitingOn: "something the box did not classify" })];
    pane();
    const row = within(screen.getByRole("list", { name: "Runs a box reports" })).getByRole("listitem");
    expect(row).toHaveTextContent("Waiting on someone the box did not name. Something the box did not classify.");
    expect(within(row).getByText("Blocked").closest("[title]")).toHaveAttribute(
      "title",
      "It waits on someone the box did not name, and keeps its process while it waits.",
    );
  });

  it("shows no wait on a working run whose box left a blocker kind behind", () => {
    state.ledger = [ledgerRow({ work: "runnable", blockerKind: "human", waitingOn: "approve the restore" })];
    pane();
    const row = within(screen.getByRole("list", { name: "Runs a box reports" })).getByRole("listitem");
    expect(row).not.toHaveTextContent(/Waiting on/);
  });

  // ISS-1228 round 14 (judge-36): a stopped run still said it waited on a person, with Open questions.
  it("shows no wait and no Open questions on a run core ended, a person's stop included", () => {
    state.ledger = [
      ledgerRow({
        work: "blocked",
        blockerKind: "human",
        waitingOn: "approve the database restore in Coolify",
        sessionStatus: "failed",
        sessionFailureReason: "user_cancelled",
      }),
    ];
    pane();
    const row = within(screen.getByRole("list", { name: "Runs a box reports" })).getByRole("listitem");
    expect(row).toHaveTextContent("Stopped");
    expect(row).not.toHaveTextContent(/Waiting on/);
    expect(within(row).queryByRole("link", { name: "Open questions" })).toBeNull();
  });

  it("links every issue key on a run a box still reports, an exited one included", () => {
    state.ledger = [
      ledgerRow({
        runId: "x",
        incarnation: "exited",
        work: "done",
        issues: [
          { issueKey: "ISS-9", leaseReturned: true },
          { issueKey: "ISS-12", leaseReturned: true },
        ],
      }),
    ];
    pane();
    const list = screen.getByRole("list", { name: "Runs a box reports" });
    expect(within(list).getByRole("link", { name: "ISS-9" })).toHaveAttribute("href", "/projects/qa/issues/ISS-9");
    expect(within(list).getByRole("link", { name: "ISS-12" })).toHaveAttribute("href", "/projects/qa/issues/ISS-12");
  });

  // Round 12: a run a box reports showed only its keys.
  it("shows each issue's title beside its key", () => {
    state.ledger = [
      ledgerRow({
        issues: [
          { issueKey: "ISS-2", leaseReturned: false, title: "j31 bravo" },
          { issueKey: "ISS-3", leaseReturned: false, title: "j31 charlie" },
        ],
      }),
    ];
    pane();
    const list = screen.getByRole("list", { name: "Runs a box reports" });
    expect(within(list).getByRole("link", { name: /^ISS-2\s*j31 bravo$/ })).toHaveAttribute("href", "/projects/qa/issues/ISS-2");
    expect(within(list).getByRole("link", { name: /^ISS-3\s*j31 charlie$/ })).toBeInTheDocument();
  });

  it("keeps the box's name and the age on one line", () => {
    state.ledger = [ledgerRow({ deviceName: "a-box-with-a-rather-long-name" })];
    pane();
    const box = within(screen.getByRole("list", { name: "Runs a box reports" })).getByText("a-box-with-a-rather-long-name");
    const line = box.parentElement as HTMLElement;
    expect(line.className).toMatch(/\bflex\b/);
    expect(line.className).not.toMatch(/flex-col|flex-wrap/);
    expect(line).toHaveTextContent(/ago$/);
  });

  it("draws each run as a flush row under a hairline, not a bordered card", () => {
    state.ledger = [ledgerRow({})];
    pane();
    const list = screen.getByRole("list", { name: "Runs a box reports" });
    expect(list.className).toMatch(/divide-y/);
    expect(within(list).getByRole("listitem").className).not.toMatch(/rounded|(^|\s)border(\s|$)/);
  });
});

describe("what a box and core each say of a run (ISS-1228 round 11)", () => {
  const row = () => within(screen.getByRole("list", { name: "Runs a box reports" })).getByRole("listitem");

  it("quotes an offline box in the past, never as saying the run is live now", () => {
    state.ledger = [
      ledgerRow({
        deviceStatus: "offline",
        observedAt: new Date(Date.now() - 52 * 60_000).toISOString(),
        sessionStatus: "failed",
        sessionFailureReason: "session_stopped_checking_in",
      }),
    ];
    pane();
    expect(row()).toHaveTextContent("The box said this was live 52m ago and is offline now. Core says the session ended.");
    expect(row()).not.toHaveTextContent("The box says this is live");
    expect(row()).toHaveTextContent("Stopped checking in");
  });

  it("does not tick a lease core still holds, and names it", () => {
    state.ledger = [
      ledgerRow({
        issues: [
          { issueKey: "ISS-4", leaseReturned: true, coreHolds: true },
          { issueKey: "ISS-5", leaseReturned: true, coreHolds: false },
        ],
      }),
    ];
    pane();
    expect(row()).toHaveTextContent("leases 1/2");
    expect(row()).toHaveTextContent(
      "The box says it returned ISS-4. Core still holds it. Stop the session to free it.",
    );
  });

  it("names the box on the row at every width, never hidden below sm", () => {
    state.ledger = [ledgerRow({ deviceName: "build-box-eu-west-long-hostname-07" })];
    pane();
    const box = within(row()).getByText("build-box-eu-west-long-hostname-07");
    expect(box.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });
});

describe("the band over the runs tab (ISS-1228 criterion 49)", () => {
  it("says nothing about open runs when no run is open", () => {
    state.runs = [run({ id: "c", status: "completed" })];
    state.total = 1;
    pane();
    expect(screen.queryByText(/open run/i)).not.toBeInTheDocument();
    expect(screen.getByText("No run is working on this project right now.")).toBeInTheDocument();
  });

  it("still says every open run has work behind it when one is open and worked", () => {
    state.runs = [run({ id: "o", status: "running", finishedAt: null, liveJobs: 1 })];
    state.total = 1;
    pane();
    expect(screen.getByText("Every open run has a job or a live agent behind it.")).toBeInTheDocument();
  });

  // ISS-1228 round 18 repair: a paused run nothing works is neither stalled nor worked.
  it("says every open run has work behind it only when every one does", () => {
    state.runs = [run({ id: "p", status: "paused", finishedAt: null, liveJobs: 0 })];
    state.total = 1;
    pane();
    expect(screen.queryByText("Every open run has a job or a live agent behind it.")).toBeNull();
    expect(screen.queryByText(/nothing working on/)).toBeNull();
  });

  // ISS-1228 round 18 repair: the band said "1 open run has nothing working on it" and named none.
  it("names each open run nothing works, by issue or kind, each linking its drawer", () => {
    const idle = { status: "running" as const, finishedAt: null, liveJobs: 0 };
    state.runs = [
      run({ ...idle, id: "r5", issueRef: "ISS-5" }),
      run({ ...idle, id: "rs", issueId: null, issueRef: null, kind: "system" }),
    ];
    state.total = 2;
    pane();
    const band = screen.getByText(/have nothing working on them/);
    expect(within(band).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["ISS-5", "/ops?run=r5"],
      ["System run", "/ops?run=rs"],
    ]);
    expect(band).toHaveTextContent("ISS-5 and System run have nothing working on them");
  });
});

// ISS-1228 round 13: judge-34 read an ended run as orange "Quiet. No report for 19m." on the row that
// said its box reported two seconds before, core's end of it as a bare "Stopped checking in", and a
// closed run's title cut to "Export the monthly report..." at 390.
describe("an ended run and a long title on the runs tab (ISS-1228 round 13)", () => {
  it("says no Quiet of a run whose session core ended, and why it ended as sentences", () => {
    state.ledger = [
      ledgerRow({
        sessionStatus: "failed",
        sessionFailureReason: "session_stopped_checking_in",
        lastActivityAt: new Date(Date.now() - 19 * 60_000).toISOString(),
        observedAt: new Date(Date.now() - 2_000).toISOString(),
      }),
    ];
    pane();
    const row = within(screen.getByRole("list", { name: "Runs a box reports" })).getByRole("listitem");
    expect(row).not.toHaveTextContent(/Quiet|No report/);
    expect(row).toHaveTextContent("The session ended. Stopped checking in.");
    expect(row).toHaveTextContent("Last reported working");
  });

  it("calls a run a person stopped Stopped while its box still reports it working, with no Quiet line", () => {
    state.ledger = [
      ledgerRow({
        sessionStatus: "failed",
        sessionFailureReason: "user_cancelled",
        lastActivityAt: new Date(Date.now() - 19 * 60_000).toISOString(),
        observedAt: new Date(Date.now() - 2_000).toISOString(),
      }),
    ];
    pane();
    const row = within(screen.getByRole("list", { name: "Runs a box reports" })).getByRole("listitem");
    expect(within(row).getByText("Stopped")).toBeInTheDocument();
    expect(row).toHaveTextContent("A person stopped the session.");
    expect(row).toHaveTextContent("The box says this is live. Core says the session ended.");
    expect(row).not.toHaveTextContent(/Cancelled|Quiet|Working/);
  });

  it("wraps a long title on a reported run and a closed one rather than cutting it", () => {
    state.ledger = [
      ledgerRow({ issues: [{ issueKey: "ISS-3", leaseReturned: false, title: "Export the monthly report as CSV" }] }),
    ];
    pane();
    const reported = screen.getByText("Export the monthly report as CSV");
    expect(reported.className).not.toMatch(/\btruncate\b/);
    expect(reported.className).toContain("break-words");
    cleanup();
    state.ledger = [];
    state.runs = [run({ id: "c1", status: "cancelled", issueRef: "ISS-3", issueTitle: "Export the monthly report as CSV" })];
    state.total = 1;
    pane();
    const closed = screen.getByText("Export the monthly report as CSV");
    expect(closed.className).not.toMatch(/\btruncate\b/);
    expect(closed.className).toContain("break-words");
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });
});

// ISS-1228 round 15 (judge-39): a runs tab open in another tab read a stopped run as live until its
// 20-second poll, because the tab joined no room, so no session event ever reached it.
describe("the runs tab hears its project's events", () => {
  it("joins the project's room", async () => {
    const { projectRoom } = await import("@/lib/ws/rooms");
    state.rooms = [];
    pane();
    expect(state.rooms).toContain(projectRoom("p1"));
  });
});

/** ISS-1228 round 19 (judge-57): one list of every open run, one word per run, whatever a box reports. */
describe("one list of every open run (round 19)", () => {
  const open = { status: "running" as const, finishedAt: null };

  it("lists a run a box reports once, in its run's row, beside every other open run, in the drawer's word", () => {
    state.ledger = [ledgerRow({ pipelineRunId: "r6", issues: [{ issueKey: "ISS-6", leaseReturned: false }] })];
    state.runs = [
      run({ ...open, id: "r1", issueRef: "ISS-1", liveJobs: 1, reading: "queued" }),
      run({ ...open, id: "r3", issueRef: "ISS-3", liveJobs: 1, reading: "starting" }),
      run({ ...open, id: "r6", issueId: null, issueRef: null, kind: "system", lane: "run_session", reading: "running", lastSessionBeatAt: new Date().toISOString() }),
    ];
    state.total = 3;
    pane();
    const rows = within(screen.getByRole("list", { name: "Open runs" })).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector("[data-run-status]")?.textContent)).toEqual(["Queued", "Starting", "Running"]);
    expect(rows[2]?.querySelector("[data-run-report]")).toHaveTextContent("box-a");
    expect(screen.queryByRole("list", { name: "Runs a box reports" })).toBeNull();
  });

  it("reads a run whose only job core holds Held, says why, and keeps it out of the band", () => {
    state.runs = [
      run({
        ...open,
        id: "h",
        issueRef: "ISS-3",
        reading: "held",
        hold: { reason: "all_devices_exhausted", resumesItself: true, recheckAt: null, since: null },
      }),
    ];
    state.total = 1;
    pane();
    const row = within(screen.getByRole("list", { name: "Open runs" })).getByRole("listitem");
    expect(row.querySelector("[data-run-status]")).toHaveTextContent("Held");
    expect(row.querySelector("[data-run-wait]")).toHaveTextContent(
      "No box could take it. Core sends it again once a box can take it.",
    );
    expect(screen.queryByText(/nothing working on/)).toBeNull();
  });

  it("reads a run session that has not checked in Starting, saying how long core waits", () => {
    state.runs = [
      run({
        ...open,
        id: "s",
        issueRef: "ISS-7",
        reading: "starting",
        checkInBy: new Date(Date.now() + 7 * 60_000 + 5_000).toISOString(),
      }),
    ];
    state.total = 1;
    pane();
    const row = within(screen.getByRole("list", { name: "Open runs" })).getByRole("listitem");
    expect(row.querySelector("[data-run-status]")).toHaveTextContent("Starting");
    expect(row.querySelector("[data-run-wait]")).toHaveTextContent(
      "It has not checked in since it opened. Core ends it in 7m if it never checks in.",
    );
  });

  it("reads a run its box reports blocked in the blocked word, with the box's wait in its row", () => {
    state.ledger = [
      ledgerRow({ pipelineRunId: "b", work: "blocked", blockerKind: "human", waitingOn: "approve the restore" }),
    ];
    state.runs = [
      run({ ...open, id: "b", issueRef: "ISS-1", reading: "blocked", block: { blockerKind: "human", parked: false } }),
    ];
    state.total = 1;
    pane();
    const row = within(screen.getByRole("list", { name: "Open runs" })).getByRole("listitem");
    const word = row.querySelector("[data-run-status]") as HTMLElement;
    expect(word).toHaveTextContent("Blocked, holding the box");
    expect(word).toHaveAttribute("title", expect.stringContaining("a person"));
    expect(row).toHaveTextContent("Waiting on a person. Approve the restore.");
  });

  it("opens each open run's drawer from its row", () => {
    state.runs = [run({ ...open, id: "r9", issueRef: "ISS-9", liveJobs: 1, reading: "queued" })];
    state.total = 1;
    pane();
    const row = within(screen.getByRole("list", { name: "Open runs" })).getByRole("listitem");
    const links = within(row).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toContain("/ops?run=r9");
  });

  it("says Started from when the run's work started, never from its opening", () => {
    const opened = new Date(Date.now() - 16 * 60_000).toISOString();
    const started = new Date(Date.now() - 60_000).toISOString();
    state.runs = [run({ ...open, id: "w", startedAt: opened, runningSince: started, reading: "running", liveJobs: 1 })];
    state.total = 1;
    pane();
    expect(screen.getByRole("list", { name: "Open runs" }).querySelector("[data-run-since]")).toHaveTextContent(
      /^Started 1m ago$/,
    );
  });
});

