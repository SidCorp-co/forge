// @vitest-environment jsdom

// cm:why the states the ux-contract says get skipped, asserted rather than eyeballed: an idle project and a filter that matched nothing look identical unless the branch that separates them exists, and the second reader then goes looking for a fault that is not there. The a11y and 375px items on that checklist are verified by hand — this covers the four render branches and the three marks (ISS-964 criteria 51, 52, 54).

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineRunListItem } from "@/features/pipeline/types";
import type { RunSessionRow } from "../types";

expect.extend(matchers);
afterEach(cleanup);

let state: {
  data?: { items: RunSessionRow[]; count: number };
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
};
const refetch = vi.fn();

/** The pipeline-runs read behind the stalled count; it carries both halves of run liveness. */
let band: {
  runs: {
    data?: { items: PipelineRunListItem[] };
    isLoading: boolean;
    isError: boolean;
    error?: unknown;
  };
};
const bandRefetch = vi.fn();

vi.mock("../hooks", () => ({
  useRunSessions: () => ({ ...state, refetch }),
}));
vi.mock("@/features/pipeline/hooks", () => ({
  useProjectRuns: () => ({ ...band.runs, refetch: bandRefetch }),
}));

const { RunsPane } = await import("./runs-pane");

const NOW = Date.now();
const runItem = (over: Partial<PipelineRunListItem> = {}): PipelineRunListItem =>
  ({
    id: "pr-1",
    projectId: "p-1",
    issueId: null,
    issueRef: null,
    issueTitle: null,
    kind: "issue",
    status: "running",
    currentStep: "drive",
    startedAt: new Date(NOW - 3_600_000).toISOString(),
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

function row(over: Partial<RunSessionRow> = {}): RunSessionRow {
  return {
    runId: "run-1",
    projectId: "p-1",
    sessionId: "sess-1",
    masterSessionId: null,
    pid: null,
    worktreePath: "/repo/.worktrees/grp-964",
    bootId: "boot-a",
    incarnation: "live",
    work: "runnable",
    blockerKind: null,
    waitingOn: null,
    sessionTerminalAt: null,
    worktreeGoneAt: null,
    issues: [{ issueKey: "ISS-964", leaseReturned: false }],
    deviceId: "d-1",
    deviceName: "dev1",
    observedAt: new Date().toISOString(),
    sessionStatus: "running",
    sessionFailureReason: null,
    lastActivityAt: new Date().toISOString(),
    masterTitle: null,
    ...over,
  } as RunSessionRow;
}

const scope = { projectId: "p-1" };

beforeEach(() => {
  band = { runs: { data: { items: [] }, isLoading: false, isError: false } };
  bandRefetch.mockClear();
});

describe("the runs pane", () => {
  it("shows a loading placeholder rather than an empty screen", () => {
    state = { isLoading: true, isError: false };
    const { container } = render(<RunsPane scope={scope} />);

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("offers a retry on failure and never a dead end", () => {
    state = { isLoading: false, isError: true, error: new Error("nope") };
    render(<RunsPane scope={scope} />);

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  // cm:guard the two empties are DIFFERENT screens and this pair is what holds them apart: the first-run copy says runs will appear, the filtered copy names the search and offers to clear it. One shared message fails the ux-contract and misleads the second reader.
  it("tells an idle project that runs will appear here", () => {
    state = { isLoading: false, isError: false, data: { items: [], count: 0 } };
    render(<RunsPane scope={scope} />);

    expect(screen.getByText(/No runs on this project/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear filters/i })).toBeNull();
  });

  it("tells a reader whose filter matched nothing, and offers to clear it", () => {
    state = { isLoading: false, isError: false, data: { items: [row()], count: 1 } };
    render(<RunsPane scope={scope} />);

    fireEvent.change(screen.getByLabelText(/filter runs/i), { target: { value: "zzz" } });

    expect(
      screen.getByText(/No runs match .zzz./i),
      "the filtered empty NAMES what was searched for; a bare `nothing here` is the first-run copy wearing the wrong hat",
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /clear filters/i }));
    expect(screen.getByText("ISS-964")).toBeInTheDocument();
  });

  it("names the state, who can end the wait, and the three marks", () => {
    state = {
      isLoading: false,
      isError: false,
      data: {
        count: 1,
        items: [
          row({
            incarnation: "exited",
            work: "blocked",
            blockerKind: "human",
            sessionTerminalAt: new Date().toISOString(),
            issues: [
              { issueKey: "ISS-964", leaseReturned: true },
              { issueKey: "ISS-933", leaseReturned: false },
            ],
          }),
        ],
      },
    };
    render(<RunsPane scope={scope} />);

    expect(screen.getByText(/Parked for a person/i)).toBeInTheDocument();
    expect(screen.getByText(/waiting on a person/i)).toBeInTheDocument();
    expect(screen.getByText("session")).toBeInTheDocument();
    expect(screen.getByText("worktree")).toBeInTheDocument();
    expect(
      screen.getByText("leases 1/2"),
      "the third mark is a COUNT, because a run over two issues can have returned one lease",
    ).toBeInTheDocument();
  });

  // cm:guard the state today's UI could not express at all, asserted on the rendered row rather than only in the derivation table: an answered park is owed a revival nobody performed, and it must be visible as its own thing (ISS-964 criteria 38, 51).
  it("shows an answered park as owed a revival", () => {
    state = {
      isLoading: false,
      isError: false,
      data: { count: 1, items: [row({ incarnation: "exited", work: "runnable" })] },
    };
    render(<RunsPane scope={scope} />);

    expect(screen.getByText(/awaiting revival/i)).toBeInTheDocument();
  });
});


describe("the count of runs nothing is working on", () => {
  // cm:guard the case the count EXISTS for, and the reason it renders outside the ledger's first-run branch: an orphaned run's box is long gone, so it has no ledger row and the screen it appears on is the one that says "No runs on this project". Inside that branch the count would be invisible here.
  it("is stated even when the box ledger holds nothing at all", () => {
    state = { isLoading: false, isError: false, data: { items: [], count: 0 } };
    band.runs = { data: { items: [runItem()] }, isLoading: false, isError: false };
    render(<RunsPane scope={scope} />);

    expect(screen.getByText(/No runs on this project/i)).toBeInTheDocument();
    expect(screen.getByText(/1 open run has nothing working on it/i)).toBeInTheDocument();
  });

  // cm:guard the pair, because either half alone passes against a broken build: a version ignoring the heartbeat entirely counts both, and one counting nothing at all counts neither.
  it("excludes a run whose session is still beating and counts one whose beat is stale", () => {
    state = { isLoading: false, isError: false, data: { items: [], count: 0 } };
    band.runs = {
      data: {
        items: [
          runItem({ id: "pr-live", lastSessionBeatAt: new Date(NOW - 5_000).toISOString() }),
          runItem({
            id: "pr-dead",
            lastSessionBeatAt: new Date(NOW - 6 * 3_600_000).toISOString(),
          }),
        ],
      },
      isLoading: false,
      isError: false,
    };
    render(<RunsPane scope={scope} />);

    expect(screen.getByText(/1 open run has nothing working on it/i)).toBeInTheDocument();
  });

  it("says every open run is accounted for when none qualifies", () => {
    state = { isLoading: false, isError: false, data: { items: [], count: 0 } };
    band.runs = { data: { items: [runItem({ liveJobs: 2 })] }, isLoading: false, isError: false };
    render(<RunsPane scope={scope} />);

    expect(screen.getByText(/Every open run has a job or a live agent/i)).toBeInTheDocument();
  });

  // cm:guard a failed read must not render as a zero: "0 runs" a reader cannot tell from an unanswered question is the reassurance this count was added to stop giving.
  it("says the read failed rather than reporting a zero, and offers the retry", () => {
    state = { isLoading: false, isError: false, data: { items: [], count: 0 } };
    band.runs = { isLoading: false, isError: true, error: new Error("nope") };
    render(<RunsPane scope={scope} />);

    expect(screen.queryByText(/nothing working on/i)).toBeNull();
    expect(screen.getByText(/Couldn.t read this project.s runs/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(bandRefetch).toHaveBeenCalled();
  });
});
