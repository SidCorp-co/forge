// @vitest-environment jsdom
//
// ISS-1277 — the board drawer's header chip and its quick-actions chip read one run state. A job no
// runner has claimed has no session; under a running pipeline run both chips say it is queued.
// ISS-1278 — with no run there is no run chip, and the issue's status is only ever its own pill.
// ISS-1297 — the Ops drawer has no issue row, so the run summary alone gives the same reading, and
// the issue's name.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as rtlRender, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PipelineIssueRow,
  PipelineRunAttempt,
  PipelineRunStatus,
  PipelineRunSummary,
} from "../types";
import { RunDetail } from "./run-detail";

expect.extend(matchers);

let run: PipelineRunSummary | undefined;
const idle = { mutate: vi.fn(), isPending: false };

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/features/shell", () => ({ buildShareLink: (p: string) => p, useRecents: () => ({ push: vi.fn() }) }));
vi.mock("./activity-feed", () => ({ ActivityTab: () => null }));
vi.mock("../hooks", () => ({
  useRun: () => ({ data: run, isLoading: false, isError: false, error: null }),
  useIssueTasks: () => ({ data: [], isLoading: false, isError: false }),
  usePauseRun: () => idle,
  useResumeRun: () => idle,
  useCancelRun: () => idle,
}));
vi.mock("@/features/issues/registry-api", () => ({
  registryApi: { get: () => ({ version: 1, runnerCapabilities: {}, statusExits: { open: ["confirmed"] } }) },
}));

const QUEUED_JOB = {
  stage: "open",
  queuedStep: { jobId: "j1", jobType: "drive", stageStatus: null, queuedAt: "2026-09-05T14:16:00Z", retryAfterAt: null },
};

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
    finishedAt: null,
    autoRetry: null,
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
    attempts: [],
    retrySummary: null,
    gateAtOpen: null,
    ...over,
  } as unknown as PipelineRunSummary;
}

function issueRow(over: Partial<PipelineIssueRow> = {}): PipelineIssueRow {
  return {
    id: "i1",
    projectId: "p1",
    displayId: "ISS-2",
    title: "A queued issue",
    status: "open",
    priority: "medium",
    assigneeId: null,
    agentStatus: null,
    held: false,
    lastCheckInAt: null,
    pipelineHealth: QUEUED_JOB,
    ...over,
  };
}

function render(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const header = () => screen.getByText("ISS-2", { selector: "*" }).parentElement as HTMLElement;
/** The quick-actions row, found by the issue status control it always holds. */
const quick = () => screen.getByRole("button", { name: /^Change status/ }).closest("div.rounded-lg") as HTMLElement;

beforeEach(() => {
  run = undefined;
});
afterEach(cleanup);

describe("the board drawer's run chips", () => {
  it("reads a queued job with no session as Queued in the header and the quick actions", () => {
    run = summary("running");
    render(<RunDetail open onClose={vi.fn()} issue={issueRow()} runId="r1" slug="forge-dev" />);
    expect(within(header()).getByText("Queued")).toBeInTheDocument();
    expect(within(header()).queryByText(/running/i)).toBeNull();
    expect(within(quick()).getByText("Queued")).toBeInTheDocument();
  });

  it("reads a running session under a running run as running in both", () => {
    run = summary("running");
    render(
      <RunDetail open onClose={vi.fn()} issue={issueRow({ agentStatus: "running", pipelineHealth: { stage: "open" } })} runId="r1" slug="forge-dev" />,
    );
    expect(within(header()).getByText("running · drive")).toBeInTheDocument();
    expect(within(quick()).getByText("Running")).toBeInTheDocument();
  });

  it("reads a queued session under a running run as Queued in both", () => {
    run = summary("running");
    render(
      <RunDetail open onClose={vi.fn()} issue={issueRow({ agentStatus: "queued", pipelineHealth: { stage: "open" } })} runId="r1" slug="forge-dev" />,
    );
    expect(within(header()).getByText("Queued")).toBeInTheDocument();
    expect(within(quick()).getByText("Queued")).toBeInTheDocument();
  });

  it("keeps a paused run's header reading Paused, not the session vocabulary's Idle", () => {
    run = summary("paused");
    render(<RunDetail open onClose={vi.fn()} issue={issueRow({ agentStatus: "running" })} runId="r1" slug="forge-dev" />);
    expect(within(header()).getByText("Paused")).toBeInTheDocument();
    expect(within(header()).queryByText("Idle")).toBeNull();
  });

  it("reads the run's own status with no issue row", () => {
    run = summary("running", { issueId: null, issueRef: null, issueTitle: null });
    render(<RunDetail open onClose={vi.fn()} issue={null} runId="r1" slug="forge-dev" />);
    expect(within(screen.getByText("run r1").parentElement as HTMLElement).getByText("running · drive")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Change status/ })).toBeNull();
  });
});

describe("the board drawer with no pipeline run", () => {
  const noRun = { pipelineHealth: { stage: "open" } };

  it("draws no run chip for an open issue with nothing running, and never reads Queued", () => {
    render(<RunDetail open onClose={vi.fn()} issue={issueRow(noRun)} runId={null} slug="forge-dev" />);
    expect(within(header()).queryByText("Queued")).toBeNull();
    expect(screen.queryAllByText("Queued")).toHaveLength(0);
    expect(within(header()).getByText("ISS-2").parentElement?.children).toHaveLength(1);
    expect(within(quick()).getAllByText("Open")).toHaveLength(1);
  });

  it("does not print a dropped issue's status as a run chip", () => {
    render(<RunDetail open onClose={vi.fn()} issue={issueRow({ ...noRun, status: "dropped" })} runId={null} slug="forge-dev" />);
    expect(within(header()).queryByText("Closed")).toBeNull();
    expect(within(quick()).getByText("Dropped")).toBeInTheDocument();
  });

  it.each([
    ["completed", "Completed"],
    ["failed", "Failed"],
    ["running", "Running"],
    ["queued", "Queued"],
  ] as const)("reads a %s session in the header as the quick actions do", (agentStatus, text) => {
    render(<RunDetail open onClose={vi.fn()} issue={issueRow({ ...noRun, agentStatus })} runId={null} slug="forge-dev" />);
    const quickChip = within(quick()).getByText(text);
    expect(within(header()).getByText(text).textContent).toBe(quickChip.textContent);
  });

  it("reads a job queued before any session as Queued, as the quick actions do", () => {
    render(<RunDetail open onClose={vi.fn()} issue={issueRow()} runId={null} slug="forge-dev" />);
    expect(within(header()).getByText("Queued")).toBeInTheDocument();
    expect(within(quick()).getByText("Queued")).toBeInTheDocument();
  });

  it("gives a read-only viewer the issue pill with the issue's own label, and no run chip", () => {
    render(<RunDetail open onClose={vi.fn()} issue={issueRow(noRun)} runId={null} slug="forge-dev" canWrite={false} />);
    expect(within(header()).getByText("Open")).toBeInTheDocument();
    expect(within(header()).queryByText("Queued")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Change status/ })).toBeNull();
  });

  it("gives a read-only viewer the issue pill beside a pipeline run's chip", () => {
    run = summary("running");
    render(
      <RunDetail open onClose={vi.fn()} issue={issueRow({ agentStatus: "running", pipelineHealth: { stage: "open" } })} runId="r1" slug="forge-dev" canWrite={false} />,
    );
    expect(within(header()).getByText("Open")).toBeInTheDocument();
    expect(within(header()).getByText("running · drive")).toBeInTheDocument();
  });

  it("draws no chip in the Ops drawer while its run has not loaded", () => {
    render(<RunDetail open onClose={vi.fn()} issue={null} runId="r1" slug="forge-dev" />);
    const opsHeader = screen.getByText("run r1").parentElement as HTMLElement;
    expect(opsHeader.children).toHaveLength(1);
    expect(within(opsHeader).queryByText("Queued")).toBeNull();
  });
});

describe("the Ops drawer, which opens a run with no issue row (ISS-1297)", () => {
  const opsHeader = () => screen.getByText("ISS-2").parentElement as HTMLElement;
  const open = () => render(<RunDetail open onClose={vi.fn()} issue={null} runId="r1" />);
  const queuedRun = () => summary("running", { attempts: [attempt("queued")] });

  it("reads a run whose only live job is queued and unclaimed as Queued, never running", () => {
    run = queuedRun();
    open();
    expect(within(opsHeader()).getByText("Queued")).toBeInTheDocument();
    expect(within(opsHeader()).queryByText(/running/i)).toBeNull();
  });

  it("reads the same header as the board drawer does for that run", () => {
    run = queuedRun();
    open();
    const ops = within(opsHeader()).getByText("Queued").textContent;
    cleanup();
    render(<RunDetail open onClose={vi.fn()} issue={issueRow()} runId="r1" slug="forge-dev" />);
    expect(within(header()).getByText("Queued").textContent).toBe(ops);
  });

  it.each(["running", "dispatched"])("still reads a %s live job as running", (status) => {
    run = summary("running", { attempts: [attempt(status)] });
    open();
    expect(within(opsHeader()).getByText("running · drive")).toBeInTheDocument();
  });

  it("reads a queued retry behind a failed attempt as Queued, not running", () => {
    run = summary("running", {
      attempts: [attempt("failed", { jobId: "j0", finishedAt: "2026-09-05T14:18:00Z" }), attempt("queued")],
    });
    open();
    expect(within(opsHeader()).getByText("Queued")).toBeInTheDocument();
  });

  it("reads a run a session has beat for as running even while its job row still says queued", () => {
    run = summary("running", { attempts: [attempt("queued")], lastSessionBeatAt: "2026-09-05T14:20:00Z" });
    open();
    expect(within(opsHeader()).getByText("running · drive")).toBeInTheDocument();
  });

  it("names the run's issue by ref and title, and a run with none still reads Pipeline run", () => {
    run = queuedRun();
    open();
    expect(screen.getByRole("heading", { name: "A queued issue" })).toBeInTheDocument();
    cleanup();
    run = summary("running", { issueId: null, issueRef: null, issueTitle: null, attempts: [attempt("queued")] });
    open();
    expect(screen.getByRole("heading", { name: "Pipeline run" })).toBeInTheDocument();
    expect(screen.getByText("run r1")).toBeInTheDocument();
  });

  it("offers neither Pause run nor Stop now for a queued run", () => {
    run = queuedRun();
    open();
    expect(screen.queryByRole("button", { name: "Pause run" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^(Stop now|Confirm stop)$/ })).toBeNull();
  });

  it("still offers both for a running run, and Resume run for a paused one", () => {
    run = summary("running", { attempts: [attempt("running")] });
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
