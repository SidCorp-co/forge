// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewScreen } from "./overview-screen";
import type { PulseResponse } from "../types";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/features/orgs/active-org", () => ({
  useActiveOrg: () => ({ activeOrg: { name: "Sidcorp", isPersonal: false }, activeOrgId: "o1" }),
}));

const projectsConsole = vi.fn(() => ({ items: [{ id: "p1" }] }));
vi.mock("@/features/projects/hooks", () => ({
  useProjectsConsole: () => projectsConsole(),
}));

const pulseApiGet = vi.fn();
vi.mock("../api", () => ({ pulseApi: { get: (...a: unknown[]) => pulseApiGet(...a) } }));

afterEach(cleanup);
beforeEach(() => {
  push.mockReset();
  pulseApiGet.mockReset();
  projectsConsole.mockReturnValue({ items: [{ id: "p1" }] });
});

const RESPONSE: PulseResponse = {
  generatedAt: "2026-09-12T12:00:00.000Z",
  thresholds: {
    abandonedIssueSeconds: 3600,
    releaseWaitingSeconds: 86_400,
    projectSilenceSeconds: 604_800,
    silenceWarnSeconds: 86_400,
    silenceAlarmSeconds: 259_200,
    identityCap: 50,
  },
  liveness: {
    jobsRunning: 0,
    jobsQueued: 0,
    jobsHeld: 0,
    liveJobs: { total: 0, shown: [] },
    stuckRuns: { total: 42, shown: [] },
    lastJobAt: "2026-09-09T12:00:00.000Z",
    silenceSeconds: 259_200,
    heartbeat: [{ date: "2026-09-11", issueRuns: 0 }],
    devices: { online: 2, draining: 0, total: 2 },
  },
  work: {
    buckets: { open: 342, inProgress: 79, awaitingRelease: 0, humanBlocked: 70 },
    abandoned: { total: 0, shown: [] },
    releaseWaiting: { total: 0, shown: [] },
    silentProjects: { total: 0, shown: [] },
    neverRanProjects: { total: 0, shown: [] },
    humanBlockedAges: [],
    perProject: [
      {
        id: "p1",
        slug: "forge-dev",
        name: "Forge Dev",
        open: 342,
        inProgress: 79,
        awaitingRelease: 0,
        humanBlocked: 70,
        stuckRuns: 42,
        abandonedIssues: 0,
        lastIssueRunAt: "2026-09-09T12:00:00.000Z",
      },
    ],
  },
  flow: [{ weekStart: "2026-09-07", created: 10, closed: 2, reopened: 0, backlog: 1110 }],
  quality: {
    finished: { merged: 10, closedUnmerged: 5, dropped: 3 },
    reopened: { issues: 2, events: 4 },
    rework: { fix: 6, code: 20 },
    runFailure: {
      pipeline: { failed: 3, total: 30 },
      scheduler: { failed: 1, total: 10 },
      other: { failed: 0, total: 2 },
    },
    sessionFailures: [{ reason: "unclassified", count: 66 }],
    pipelineFlow: [{ type: "code", count: 40, medianSeconds: 600 }],
  },
};

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OverviewScreen />
    </QueryClientProvider>,
  );
}

describe("OverviewScreen", () => {
  // cm:guard the five sections answer the issue's questions IN ORDER, and the order is the requirement — a layout that reads well but answers them in another sequence fails this and nothing else catches it (ISS-988 criterion 25)
  it("renders the five sections in the issue's reading order", async () => {
    pulseApiGet.mockResolvedValue(RESPONSE);
    mount();
    await waitFor(() => expect(screen.getByText("Is it alive?")).toBeTruthy());
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      "Is it alive?",
      "Where the work is sitting",
      "What needs someone",
      "Which way the flow is going",
      "Whether the output holds",
    ]);
  });

  it("renders a loading state while the request is in flight", () => {
    pulseApiGet.mockReturnValue(new Promise(() => {}));
    const { container } = mount();
    expect(container.querySelectorAll(".rounded-lg").length).toBeGreaterThan(0);
    expect(screen.queryByText("Is it alive?")).toBeNull();
  });

  it("renders an error state with a retry that refetches", async () => {
    pulseApiGet.mockRejectedValue(new Error("nope"));
    mount();
    await waitFor(() => expect(screen.getByText(/Couldn't load your workspace/)).toBeTruthy());
    const calls = pulseApiGet.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(pulseApiGet.mock.calls.length).toBeGreaterThan(calls));
  });

  // cm:guard the empty state is keyed on the SCOPED project list, so an org holding nothing gets its own screen rather than five sections of zeros (ISS-988 criterion 53)
  it("renders its own empty state when the scoped org holds no project", async () => {
    pulseApiGet.mockResolvedValue({
      ...RESPONSE,
      work: { ...RESPONSE.work, perProject: [] },
    });
    mount();
    await waitFor(() =>
      expect(screen.getByText(/No projects in Sidcorp yet/)).toBeTruthy(),
    );
    expect(screen.queryByText("Is it alive?")).toBeNull();
  });

  // cm:guard spend is not an operational signal and left this surface with ISS-988; a money figure creeping back is what this assertion exists to catch (ISS-988 criterion 51)
  it("shows no spend or money figure anywhere", async () => {
    pulseApiGet.mockResolvedValue(RESPONSE);
    const { container } = mount();
    await waitFor(() => expect(screen.getByText("Is it alive?")).toBeTruthy());
    expect(container.textContent).not.toMatch(/\$|spend|cost|USD/i);
  });

  // cm:guard the old KPI row's `avgCycleTimeDays` was a mean of per-project averages; the words it rendered under must not return with it (ISS-988 criterion 52)
  it("shows no average-of-averages cycle-time figure", async () => {
    pulseApiGet.mockResolvedValue(RESPONSE);
    const { container } = mount();
    await waitFor(() => expect(screen.getByText("Is it alive?")).toBeTruthy());
    expect(container.textContent).not.toMatch(/cycle time|avg|average/i);
  });

  it("scopes the read to the active organization", async () => {
    pulseApiGet.mockResolvedValue(RESPONSE);
    mount();
    await waitFor(() => expect(pulseApiGet).toHaveBeenCalledWith("o1"));
  });
});
