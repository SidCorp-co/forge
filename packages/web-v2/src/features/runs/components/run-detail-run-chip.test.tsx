// @vitest-environment jsdom
//
// ISS-1297 — the Ops drawer opens a run by id alone, so the run summary gives its header reading
// and the issue's name. A job no runner has claimed has no session, and reads queued.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as rtlRender, screen, within } from "@testing-library/react";
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
    render(<RunDetail open onClose={vi.fn()} runId="r1" slug="forge-dev" />);
    const opsHeader = screen.getByText("run r1").parentElement as HTMLElement;
    expect(opsHeader.children).toHaveLength(1);
    expect(within(opsHeader).queryByText("Queued")).toBeNull();
  });
});

describe("the Ops drawer, which opens a run with no issue row (ISS-1297)", () => {
  const opsHeader = () => screen.getByText("ISS-2").parentElement as HTMLElement;
  const open = () => render(<RunDetail open onClose={vi.fn()} runId="r1" />);
  const queuedRun = () => summary("running", { attempts: [attempt("queued")] });

  it("reads a run whose only live job is queued and unclaimed as Queued, never running", () => {
    run = queuedRun();
    open();
    expect(within(opsHeader()).getByText("Queued")).toBeInTheDocument();
    expect(within(opsHeader()).queryByText(/running/i)).toBeNull();
  });

  it("still reads a running live job as running", () => {
    run = summary("running", { attempts: [attempt("running")] });
    open();
    expect(within(opsHeader()).getByText("running · drive")).toBeInTheDocument();
  });

  it("still reads a job handed to a runner as running", () => {
    run = summary("running", { attempts: [attempt("dispatched")] });
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

describe("the run drawer's tabs", () => {
  it("offers Activity, Timeline and Cost, with no Tasks tab", () => {
    run = summary("running");
    render(<RunDetail open onClose={vi.fn()} runId="r1" slug="forge-dev" />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Activity", "Timeline", "Cost"]);
    expect(screen.queryByRole("tab", { name: /tasks/i })).toBeNull();
  });
});
