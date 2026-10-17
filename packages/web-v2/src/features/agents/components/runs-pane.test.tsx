// @vitest-environment jsdom
//
// ISS-1228 — the Agents runs tab lists what the boxes report running. Where they report none, it says
// no run is working rather than that the project has no runs, and lists the runs that have closed.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineRunListItem } from "@/features/runs/types";
import type { RunSessionRow } from "../types";
import { RunsPane } from "./runs-pane";

expect.extend(matchers);

const state = vi.hoisted(() => ({
  runs: [] as unknown[],
  total: 0,
  ledger: [] as unknown[],
  failed: false,
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/projects/qa/agents" }));
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
      "Cancelled",
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
    expect(screen.getByText("No box reports a run here, though 1 open run has work behind it.")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Closed runs" })).getAllByRole("listitem")).toHaveLength(1);
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
  it("shows what a blocked run waits on in the box's own words", () => {
    state.ledger = [
      ledgerRow({ work: "blocked", blockerKind: "human", waitingOn: "approve the database restore in Coolify" }),
    ];
    pane();
    const row = within(screen.getByRole("list", { name: "Runs a box reports" })).getByRole("listitem");
    expect(row).toHaveTextContent("Waiting on a person — approve the database restore in Coolify");
    expect(row).not.toHaveTextContent(/read the decision/);
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
});
