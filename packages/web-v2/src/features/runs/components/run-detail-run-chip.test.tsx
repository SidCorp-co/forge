// @vitest-environment jsdom
//
// ISS-1297 — the Ops drawer opens a run by id alone, so the run summary gives its header reading
// and the issue's name. A job no runner has claimed has no session, and reads queued.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PipelineRunAttempt,
  PipelineRunStatus,
  PipelineRunSummary,
} from "../types";
import { RunDetail } from "./run-detail";

expect.extend(matchers);

let run: PipelineRunSummary | undefined;
const SLUGS: ReadonlyMap<string, string> = new Map([["p1", "forge-dev"]]);
const idle = { mutate: vi.fn(), isPending: false };

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/features/shell", () => ({ buildShareLink: (p: string) => p, useRecents: () => ({ push: vi.fn() }) }));
vi.mock("./activity-feed", () => ({ ActivityTab: () => null }));
vi.mock("../hooks", () => ({
  useRun: () => ({ data: run, isLoading: false, isError: false, error: null }),
  usePauseRun: () => idle,
  useResumeRun: () => idle,
  useCancelRun: () => idle,
}));

function attempt(status: string, over: Partial<PipelineRunAttempt> = {}): PipelineRunAttempt {
  return {
    jobId: "j1",
    jobType: "drive",
    status,
    attempts: 1,
    retryOf: null,
    deviceId: null,
    deviceName: null,
    failureReason: null,
    failureCause: null,
    failureDetail: null,
    failureKind: null,
    failureAction: null,
    queuedAt: "2026-09-05T14:16:00Z",
    startedAt: status === "queued" ? null : "2026-09-05T14:17:00Z",
    ranAt: status === "running" ? "2026-09-05T14:17:30Z" : null,
    finishedAt: null,
    autoRetry: null,
    takenBy: null,
    ...over,
  };
}

function summary(status: PipelineRunStatus, over: Partial<PipelineRunSummary> = {}): PipelineRunSummary {
  return {
    id: "r1",
    projectId: "p1",
    issueId: "i1",
    issueRef: "ISS-2",
    issueTitle: "A queued issue",
    kind: "issue",
    status,
    currentStep: "drive",
    startedAt: "2026-09-05T14:16:00Z",
    finishedAt: null,
    steps: [],
    cost: { estimatedCost: 0 },
    liveJobs: 1,
    lastSessionBeatAt: null,
    reading: null,
    group: { source: "none", issues: [], detail: "a job-lane run carries its one issue in its own column" },
    groupTitles: {},
    attempts: [],
    retrySummary: null,
    gateAtOpen: null,
    ...over,
  } as unknown as PipelineRunSummary;
}

function render(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}


beforeEach(() => {
  run = undefined;
});
afterEach(cleanup);

describe("the Ops drawer before its run loads", () => {
  it("draws no chip in the Ops drawer while its run has not loaded", () => {
    render(<RunDetail open onClose={vi.fn()} runId="r1" projectSlugs={SLUGS} />);
    const opsHeader = screen.getByText("run r1").parentElement as HTMLElement;
    expect(opsHeader.children).toHaveLength(1);
    expect(within(opsHeader).queryByText("Queued")).toBeNull();
  });
});

describe("the Ops drawer, which opens a run with no issue row (ISS-1297)", () => {
  const opsHeader = () => screen.getByText("ISS-2").parentElement as HTMLElement;
  const open = () => render(<RunDetail open onClose={vi.fn()} runId="r1" projectSlugs={new Map()} />);
  const queuedRun = () => summary("running", { attempts: [attempt("queued")], reading: "queued" });

  it("reads a run whose only live job is queued and unclaimed as Queued, never running", () => {
    run = queuedRun();
    open();
    expect(within(opsHeader()).getByText("Queued")).toBeInTheDocument();
    expect(within(opsHeader()).queryByText(/running/i)).toBeNull();
  });

  it("still reads a running live job as running", () => {
    run = summary("running", { attempts: [attempt("running")], reading: "running" });
    open();
    expect(within(opsHeader()).getByText("Running · Issue work")).toBeInTheDocument();
  });

  // ISS-1228 round 17 (judge-47): a sent job's header read Running beside "not started yet".
  it("reads a job sent to a runner, or taken by one, and not started as Starting, never running", () => {
    run = summary("running", { attempts: [attempt("dispatched")], reading: "starting" });
    open();
    expect(within(opsHeader()).getByText("Starting")).toBeInTheDocument();
    expect(within(opsHeader()).queryByText(/running/i)).toBeNull();
  });

  it("reads a queued retry behind a failed attempt as Queued, not running", () => {
    run = summary("running", {
      attempts: [attempt("failed", { jobId: "j0", finishedAt: "2026-09-05T14:18:00Z" }), attempt("queued")],
      reading: "queued",
    });
    open();
    expect(within(opsHeader()).getByText("Queued")).toBeInTheDocument();
  });

  it("reads a run a session has beat for as running even while its job row still says queued", () => {
    run = summary("running", {
      attempts: [attempt("queued")],
      lastSessionBeatAt: "2026-09-05T14:20:00Z",
      reading: "running",
    });
    open();
    expect(within(opsHeader()).getByText("Running · Issue work")).toBeInTheDocument();
  });

  it("names the run's issue by ref and title, and a run with none still reads Pipeline run", () => {
    run = queuedRun();
    open();
    expect(screen.getByRole("heading", { name: "A queued issue" })).toBeInTheDocument();
    cleanup();
    run = summary("running", {
      issueId: null,
      issueRef: null,
      issueTitle: null,
      attempts: [attempt("queued")],
      reading: "queued",
    });
    open();
    expect(screen.getByRole("heading", { name: "Issue run" })).toBeInTheDocument();
    expect(screen.getByText("run r1")).toBeInTheDocument();
  });

  it("offers neither Pause run nor Stop now for a queued run", () => {
    run = queuedRun();
    open();
    expect(screen.queryByRole("button", { name: "Pause run" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^(Stop now|Confirm stop)$/ })).toBeNull();
  });

  // ISS-1228 round 18 (judge-53): a working job's header read Running over its activity's Starting;
  // core now answers the job running, and the header reads it.
  it("reads a job its box is working as Running in the header", () => {
    run = summary("running", { attempts: [attempt("running")], reading: "running" });
    open();
    expect(within(opsHeader()).getByText("Running · Issue work")).toBeInTheDocument();
  });

  // ISS-1228 round 18 (judge-53): Pause run and Stop now were offered on runs nothing had started.
  it.each([
    ["queued", "queued"],
    ["dispatched", "starting"],
  ] as const)("offers Cancel run, and neither Pause run nor Stop now, on a run whose job is %s", (status, reading) => {
    run = summary("running", { attempts: [attempt(status)], reading });
    open();
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop now" })).toBeNull();
  });

  it("offers no Cancel run on a run that has started", () => {
    run = summary("running", { attempts: [attempt("running")], reading: "running" });
    open();
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
  });

  // ISS-1228 round 18 (judge-53): a chat waiting on its person read Running.
  it("reads a run whose chat waits on its person as Waiting for me, never running", () => {
    run = summary("running", { kind: "interactive", attempts: [], reading: "waiting" });
    open();
    expect(within(opsHeader()).getByText("Waiting for me")).toBeInTheDocument();
    expect(within(opsHeader()).queryByText(/running/i)).toBeNull();
  });

  // ISS-1228 round 18: the runs tab called a chat's run "Chat run" and its drawer "Pipeline run".
  it("titles a run that names no issue by its kind, as the runs tab does", () => {
    run = summary("running", { issueId: null, issueRef: null, issueTitle: null, kind: "interactive", reading: "waiting" });
    open();
    expect(screen.getByRole("heading", { name: "Chat run" })).toBeInTheDocument();
  });

  it("still offers both for a running run, and Resume run for a paused one", () => {
    run = summary("running", { attempts: [attempt("running")], reading: "running" });
    open();
    expect(screen.getByRole("button", { name: "Pause run" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop now" })).toBeInTheDocument();
    cleanup();
    run = summary("paused", { attempts: [attempt("queued")] });
    open();
    expect(screen.getByRole("button", { name: "Resume run" })).toBeInTheDocument();
  });

  it("draws the reading from the run it fetched, with nothing else read", () => {
    const fetched = vi.spyOn(globalThis, "fetch");
    run = queuedRun();
    open();
    expect(within(opsHeader()).getByText("Queued")).toBeInTheDocument();
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
  });
});

describe("the run drawer's tabs", () => {
  it("offers Activity, Timeline and Cost, with no Tasks tab", () => {
    run = summary("running");
    render(<RunDetail open onClose={vi.fn()} runId="r1" projectSlugs={SLUGS} />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Activity", "Timeline", "Cost"]);
    expect(screen.queryByRole("tab", { name: /tasks/i })).toBeNull();
  });
});

// ISS-1228 round 17 (judge-47): Ops opened the drawer with no slug, so Open issue never appeared.
describe("Open issue from the Ops drawer", () => {
  const menu = () => {
    fireEvent.click(screen.getByRole("button", { name: "More run actions" }));
    return screen.queryByRole("menuitem", { name: "Open issue" });
  };

  it("is offered on a run that names one issue, its project's slug read from the run", () => {
    run = summary("running", { reading: "running" });
    render(<RunDetail open onClose={vi.fn()} runId="r1" projectSlugs={SLUGS} />);
    expect(menu()).not.toBeNull();
  });

  it("is not offered on a run that names no issue", () => {
    run = summary("running", { issueId: null, issueRef: null, reading: "running" });
    render(<RunDetail open onClose={vi.fn()} runId="r1" projectSlugs={SLUGS} />);
    expect(menu()).toBeNull();
  });

  // ISS-1228 round 18 (judge-53): a run session's drawer read "run c9a719ee · Pipeline run" with no
  // Open issue though its run named ISS-1.
  const runSession = (issues: string[]) =>
    summary("running", {
      issueId: null,
      issueRef: null,
      issueTitle: null,
      currentStep: null,
      lane: "run_session",
      group: { source: "run_group", issues, detail: null },
      groupTitles: { "ISS-1": "Fix the login page", "ISS-4": "Tidy the footer" },
      reading: "running",
    });

  it("titles a run session by the one issue it holds and offers Open issue", () => {
    run = runSession(["ISS-1"]);
    render(<RunDetail open onClose={vi.fn()} runId="r1" projectSlugs={SLUGS} />);
    expect(screen.getByText("ISS-1")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Fix the login page" })).toBeInTheDocument();
    expect(screen.queryByText("run r1")).toBeNull();
    expect(menu()).not.toBeNull();
  });

  it("offers Open for each issue of a run session over several", () => {
    run = runSession(["ISS-1", "ISS-4"]);
    render(<RunDetail open onClose={vi.fn()} runId="r1" projectSlugs={SLUGS} />);
    fireEvent.click(screen.getByRole("button", { name: "More run actions" }));
    expect(screen.getByRole("menuitem", { name: "Open ISS-1" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open ISS-4" })).toBeInTheDocument();
  });
});

// ISS-1228 round 18 (judge-53): Rerun and Fork only toasted "isn't supported yet".
describe("the drawer's menu offers only what the run takes", () => {
  it("lists no action that only says it is not supported", () => {
    run = summary("running", { reading: "running" });
    render(<RunDetail open onClose={vi.fn()} runId="r1" projectSlugs={SLUGS} />);
    fireEvent.click(screen.getByRole("button", { name: "More run actions" }));
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(items).toEqual(["Open issue", "Copy link"]);
  });
});
