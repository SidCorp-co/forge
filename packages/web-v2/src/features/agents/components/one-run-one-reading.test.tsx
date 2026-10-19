// @vitest-environment jsdom
//
// ISS-1228 criterion 135: one run reads one word on the Agents runs tab, in its Ops drawer header and
// in its activity. The coordinator's read of the round-18 shots put ISS-1 at Queued on the tab beside
// Starting in its drawer, and a run the band counted as having nothing working was named nowhere.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as rtlRender, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "@/features/runs/components/run-detail";
import type { PipelineRunAttempt, PipelineRunSummary, RunReading } from "@/features/runs/types";
import { RunsPane } from "./runs-pane";

expect.extend(matchers);

const state = vi.hoisted(() => ({ run: undefined as unknown }));
const idle = { mutate: vi.fn(), isPending: false };

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/rigjobs/agents",
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: vi.fn() }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/features/shell", () => ({ buildShareLink: (p: string) => p, useRecents: () => ({ push: vi.fn() }) }));
vi.mock("../hooks", () => ({
  useRunSessions: () => ({ data: { items: [], count: 0 }, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
}));
vi.mock("@/features/runs/hooks", () => ({
  useProjectRuns: () => ({
    data: { items: state.run ? [state.run] : [], totalCount: state.run ? 1 : 0 },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useRun: () => ({ data: state.run, isLoading: false, isError: false, error: null }),
  usePauseRun: () => idle,
  useResumeRun: () => idle,
  useCancelRun: () => idle,
}));

afterEach(() => {
  cleanup();
  state.run = undefined;
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function attempt(over: Partial<PipelineRunAttempt>): PipelineRunAttempt {
  return {
    jobId: "j1",
    jobType: "drive",
    status: "queued",
    attempts: 1,
    retryOf: null,
    deviceId: null,
    deviceName: null,
    failureReason: null,
    failureCause: null,
    failureDetail: null,
    failureKind: null,
    failureAction: null,
    queuedAt: minutesAgo(12),
    startedAt: null,
    ranAt: null,
    finishedAt: null,
    autoRetry: null,
    takenBy: null,
    ...over,
  };
}

function openRun(issueRef: string, reading: RunReading | null, attempts: PipelineRunAttempt[], liveJobs: number) {
  return {
    id: `run-${issueRef}`,
    projectId: "p1",
    issueId: `i-${issueRef}`,
    issueRef,
    issueTitle: `The ${issueRef} issue`,
    lane: "job",
    group: { source: "none", issues: [], detail: "a job-lane run carries its one issue in its own column" },
    groupTitles: {},
    kind: "issue",
    status: "running",
    currentStep: "drive",
    startedAt: minutesAgo(12),
    finishedAt: null,
    steps: [],
    cost: { estimatedCost: 0 },
    liveJobs,
    lastSessionBeatAt: null,
    reading,
    attempts,
    retrySummary: null,
    gateAtOpen: null,
  } as unknown as PipelineRunSummary;
}

function render(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** The word the runs tab's row says of the run. */
function rowWord(issueRef: string): string {
  render(<RunsPane scope={{ projectId: "p1", slug: "rigjobs" }} />);
  const row = screen.getByText(issueRef).closest("li") as HTMLElement;
  const word = row.querySelector("[data-run-status]")?.textContent ?? "";
  cleanup();
  return word;
}

/** What the Ops drawer says: the word its header chip opens with, and each activity row's text. */
function drawer(issueRef: string): { header: string; rows: string[]; verbs: string[] } {
  render(<RunDetail open onClose={vi.fn()} runId="r" projectSlugs={new Map([["p1", "rigjobs"]])} />);
  const headerText = (screen.getByText(issueRef).parentElement as HTMLElement).textContent ?? "";
  const items = Array.from(document.querySelectorAll("li"));
  const rows = items.map((li) => li.textContent ?? "");
  const verbs = items.map((li) => li.querySelector("span.font-semibold")?.textContent ?? "");
  cleanup();
  return { header: headerText.replace(issueRef, "").split(" · ")[0]?.trim() ?? "", rows, verbs };
}

describe("one run, one word on the runs tab, the drawer header and the activity (criterion 135)", () => {
  it.each([
    [
      "a job a master took and its box has not started",
      "Starting",
      openRun("ISS-1", "starting", [attempt({ takenBy: { deviceId: "d-b", deviceName: "box-b" } })], 1),
    ],
    ["the same job once core gave its take back", "Queued", openRun("ISS-1", "queued", [attempt({})], 1)],
    [
      "a job its box is working",
      "Running",
      openRun("ISS-3", "running", [attempt({ status: "running", deviceName: "box-a", startedAt: minutesAgo(5), ranAt: minutesAgo(4) })], 1),
    ],
  ])("reads %s as %s on all three", (_what, word, run) => {
    state.run = run;
    const ref = run.issueRef as string;
    const row = rowWord(ref);
    const { header, verbs } = drawer(ref);
    expect({ row, header, activity: verbs.at(-1) }).toEqual({ row: word, header: word, activity: word });
  });

  it("names a run nothing is working in the band, linking its drawer, and its drawer reads Nothing working", () => {
    const never = attempt({
      status: "failed",
      deviceName: "box-a",
      deviceId: "d-a",
      finishedAt: minutesAgo(9),
      failureCause: "queue_timeout",
      failureReason: "dispatch never claimed by a runner (no ack / no started event within grace window)",
    });
    state.run = openRun("ISS-5", null, [never], 0);
    render(<RunsPane scope={{ projectId: "p1", slug: "rigjobs" }} />);
    const band = screen.getByText(/nothing working on it/);
    const link = within(band).getByRole("link", { name: "ISS-5" });
    expect(link).toHaveAttribute("href", "/ops?run=run-ISS-5");
    cleanup();
    const { header, rows } = drawer("ISS-5");
    expect(header).toBe("Nothing working");
    // Its one attempt is over, so the activity says what became of it rather than what the run is doing.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("Never started");
    expect(rows[0]).toContain("box-a never took it before the queue timeout");
    expect(rows[0]).not.toContain("dispatch never claimed");
  });
});
