// @vitest-environment jsdom
//
// ISS-1277 — the board drawer's header chip and its quick-actions chip read one run state. A job no
// runner has claimed has no session; under a running pipeline run both chips say it is queued.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as rtlRender, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineIssueRow, PipelineRunStatus, PipelineRunSummary } from "../types";
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

function summary(status: PipelineRunStatus): PipelineRunSummary {
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
    run = summary("running");
    render(<RunDetail open onClose={vi.fn()} issue={null} runId="r1" slug="forge-dev" />);
    expect(within(screen.getByText("run r1").parentElement as HTMLElement).getByText("running · drive")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Change status/ })).toBeNull();
  });
});
