// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionQueue } from "./action-queue";
import { FlowSection } from "./flow-section";
import { LivenessBand } from "./liveness-band";
import { QualitySection } from "./quality-section";
import { WorkSitting } from "./work-sitting";
import type {
  PulseLiveness,
  PulseQuality,
  PulseResponse,
  PulseThresholds,
} from "../types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(cleanup);

const THRESHOLDS: PulseThresholds = {
  abandonedIssueSeconds: 3600,
  releaseWaitingSeconds: 86_400,
  projectSilenceSeconds: 604_800,
  silenceWarnSeconds: 86_400,
  silenceAlarmSeconds: 259_200,
  identityCap: 2,
};

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

const liveness = (over: Partial<PulseLiveness> = {}): PulseLiveness => ({
  jobsRunning: 0,
  jobsQueued: 0,
  jobsHeld: 0,
  liveJobs: { total: 0, shown: [] },
  stuckRuns: { total: 0, shown: [] },
  lastJobAt: null,
  silenceSeconds: null,
  heartbeat: [],
  devices: { online: 0, draining: 0, total: 0 },
  ...over,
});

const QUALITY: PulseQuality = {
  finished: { merged: 10, closedUnmerged: 5, dropped: 3 },
  reopened: { issues: 2, events: 4 },
  rework: { fix: 6, code: 20 },
  runFailure: {
    pipeline: { failed: 3, total: 30 },
    scheduler: { failed: 1, total: 10 },
    other: { failed: 0, total: 2 },
  },
  sessionFailures: [
    { reason: "unclassified", count: 66 },
    { reason: "runner_unreachable", count: 34 },
  ],
  pipelineFlow: [
    { type: "code", count: 40, medianSeconds: 600 },
    { type: "fix", count: 12, medianSeconds: 300 },
  ],
};

const pulse = (over: Partial<PulseResponse["work"]> = {}): PulseResponse => ({
  generatedAt: new Date(NOW).toISOString(),
  thresholds: THRESHOLDS,
  liveness: liveness(),
  work: {
    buckets: { open: 342, inProgress: 79, awaitingRelease: 0, humanBlocked: 70 },
    abandoned: { total: 0, shown: [] },
    releaseWaiting: { total: 0, shown: [] },
    silentProjects: { total: 0, shown: [] },
    neverRanProjects: { total: 0, shown: [] },
    humanBlockedAges: [],
    perProject: [],
    ...over,
  },
  flow: [],
  quality: QUALITY,
});

describe("LivenessBand", () => {
  // cm:guard an all-zero heartbeat must still render the trace: the whole point of the section is that "nothing ran for three days" is visible, and a falsy guard on the values renders the fallback text instead (ISS-988 criteria 26, 48)
  it("draws the heartbeat when every day in the window is zero", () => {
    render(
      <LivenessBand
        liveness={liveness({
          heartbeat: [
            { date: "2026-09-10", issueRuns: 0 },
            { date: "2026-09-11", issueRuns: 0 },
          ],
        })}
        thresholds={THRESHOLDS}
      />,
    );
    expect(screen.getByRole("img", { name: /Nothing ran on any of them/ })).toBeTruthy();
  });

  // cm:guard a section whose series the response omits renders the figures it DOES hold, never an empty frame (ISS-988 criterion 49)
  it("falls back to the figures it holds when the series is absent", () => {
    render(
      <LivenessBand
        liveness={liveness({ jobsRunning: 2, stuckRuns: { total: 42, shown: [] } })}
        thresholds={THRESHOLDS}
      />,
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(/No heartbeat series in this response/)).toBeTruthy();
  });

  it("states the silence and marks it once each threshold is passed", () => {
    const { rerender } = render(
      <LivenessBand liveness={liveness({ silenceSeconds: 45 })} thresholds={THRESHOLDS} />,
    );
    expect(screen.getByText(/Silent for 45s/)).toBeTruthy();
    expect(screen.queryByText(/past the/)).toBeNull();

    rerender(
      <LivenessBand
        liveness={liveness({ silenceSeconds: THRESHOLDS.silenceWarnSeconds })}
        thresholds={THRESHOLDS}
      />,
    );
    expect(screen.getByText(/past the first mark/)).toBeTruthy();

    rerender(
      <LivenessBand
        liveness={liveness({ silenceSeconds: THRESHOLDS.silenceAlarmSeconds })}
        thresholds={THRESHOLDS}
      />,
    );
    expect(screen.getByText(/past the alarm mark/)).toBeTruthy();
  });

  // cm:guard the panel says shown-of-total whenever the response capped its list: presenting two of forty-two as the whole is the truncation-as-truth defect (ISS-988 criterion 46)
  it("opens the stuck runs and says how many of the total it shows", () => {
    render(
      <LivenessBand
        liveness={liveness({
          stuckRuns: {
            total: 42,
            shown: [
              { runId: "r1", projectSlug: "forge-dev", issueRef: "ISS-1", issueDocId: "d1", ageSeconds: 60 },
              { runId: "r2", projectSlug: "forge-dev", issueRef: null, issueDocId: null, ageSeconds: 30 },
            ],
          },
        })}
        thresholds={THRESHOLDS}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /42 runs claimed but empty/ }));
    expect(screen.getByText("Runs claimed but empty — showing 2 of 42")).toBeTruthy();
  });

  it("names the runners door by what it opens", () => {
    render(
      <LivenessBand
        liveness={liveness({ devices: { online: 1, draining: 0, total: 3 } })}
        thresholds={THRESHOLDS}
      />,
    );
    const link = screen.getByRole("link", { name: /1 of 3 runners online — open Runners/ });
    expect(link.getAttribute("href")).toBe("/runners");
  });
});

describe("WorkSitting", () => {
  it("draws the four buckets and links each project row to exactly its bucket", () => {
    render(
      <WorkSitting
        pulse={pulse({
          perProject: [
            {
              id: "p1",
              slug: "forge-dev",
              name: "Forge Dev",
              open: 5,
              inProgress: 2,
              awaitingRelease: 0,
              humanBlocked: 1,
              stuckRuns: 0,
              abandonedIssues: 0,
              lastIssueRunAt: "2026-09-12T11:00:00.000Z",
            },
          ],
        })}
        nowMs={NOW}
      />,
    );
    const link = screen.getByRole("link", { name: /Forge Dev: 5 Open, not picked up/ });
    expect(link.getAttribute("href")).toBe(
      "/projects/forge-dev/issues?status=open,confirmed,clarified,approved",
    );
  });

  // cm:guard a never-ran project is named as such rather than shown as the longest silence, and it sorts first (ISS-988 criteria 29-30)
  it("orders by silence and names a project that never ran", () => {
    render(
      <WorkSitting
        pulse={pulse({
          perProject: [
            { id: "p1", slug: "recent", name: "Recent", open: 1, inProgress: 0, awaitingRelease: 0, humanBlocked: 0, stuckRuns: 0, abandonedIssues: 0, lastIssueRunAt: "2026-09-12T11:00:00.000Z" },
            { id: "p2", slug: "never", name: "Never", open: 200, inProgress: 0, awaitingRelease: 0, humanBlocked: 0, stuckRuns: 0, abandonedIssues: 0, lastIssueRunAt: null },
          ],
        })}
        nowMs={NOW}
      />,
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("Never")).toBeTruthy();
    expect(within(rows[0]).getByText("never ran")).toBeTruthy();
  });

  it("draws one dot per human-blocked issue", () => {
    const { container } = render(
      <WorkSitting pulse={pulse({ humanBlockedAges: [10, 20, 30] })} nowMs={NOW} />,
    );
    expect(container.querySelectorAll("span[aria-hidden].rounded-full").length).toBe(3);
  });
});

describe("ActionQueue", () => {
  const queued = pulse({
    abandoned: {
      total: 3,
      shown: [
        { documentId: "d1", issueRef: "ISS-977", title: "A", status: "in_progress", projectSlug: "forge-dev", ageSeconds: 61_200 },
      ],
    },
    releaseWaiting: {
      total: 1,
      shown: [
        { documentId: "d2", issueRef: "ISS-9", title: "B", status: "awaiting_release", projectSlug: "forge-dev", ageSeconds: 100 },
      ],
    },
  });

  it("lists one row per condition, oldest first, each saying who ends it", () => {
    render(<ActionQueue pulse={queued} nowMs={NOW} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons[0].textContent).toContain("In-flight issues nobody is working");
    expect(buttons[0].textContent).toContain("A person unblocks this");
    expect(buttons[1].textContent).toContain("Waiting to be released");
  });

  it("opens a row's records and says how many of the total it shows", () => {
    render(<ActionQueue pulse={queued} nowMs={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: /In-flight issues nobody is working: 3/ }));
    expect(screen.getByText(/showing 1 of 3/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /ISS-977/ }).getAttribute("href")).toBe(
      "/projects/forge-dev/issues/d1",
    );
  });

  it("says so plainly when nothing needs anyone", () => {
    render(<ActionQueue pulse={pulse()} nowMs={NOW} />);
    expect(screen.getByText(/Nothing is stuck/)).toBeTruthy();
  });
});

describe("FlowSection", () => {
  it("renders a table of what it holds when the series is absent", () => {
    render(<FlowSection flow={[]} />);
    expect(screen.getByText(/No weekly series in this response/)).toBeTruthy();
  });

  // cm:guard the drift must span the WHOLE window: this plants a first week that creates 100 and closes none, so reading `flow[0].backlog` as the start reports "down 50" over a window in which the backlog rose by 50 (ISS-988 criterion 36)
  it("counts the first week's movement into the window it claims to cover", () => {
    render(
      <FlowSection
        flow={[
          { weekStart: "2026-06-29", created: 100, closed: 0, reopened: 0, backlog: 100 },
          { weekStart: "2026-07-06", created: 0, closed: 50, reopened: 0, backlog: 50 },
        ]}
      />,
    );
    expect(screen.getByText(/Backlog up 50 over 2 weeks — 0 to 50/)).toBeTruthy();
  });

  it("draws created against closed with the backlog they leave", () => {
    render(
      <FlowSection
        flow={[
          { weekStart: "2026-06-29", created: 10, closed: 2, reopened: 0, backlog: 543 },
          { weekStart: "2026-09-07", created: 12, closed: 3, reopened: 1, backlog: 1110 },
        ]}
      />,
    );
    expect(screen.getByRole("img", { name: /Backlog went from 535 to 1110/ })).toBeTruthy();
    expect(screen.getByText(/Backlog up 575 over 2 weeks/)).toBeTruthy();
  });
});

describe("QualitySection", () => {
  it("draws the composition, the paired rates and the unclassified share", () => {
    render(<QualitySection quality={QUALITY} />);
    expect(screen.getByText("Closed with merge evidence")).toBeTruthy();
    expect(screen.getByText("10 of 18")).toBeTruthy();
    expect(screen.getByText("Pipeline runs failed")).toBeTruthy();
    expect(screen.getByText("3 of 30")).toBeTruthy();
    expect(screen.getByText(/66% unclassified/)).toBeTruthy();
  });

  // cm:guard `pm` and `interactive` runs belong to `other` and must be drawn as their own lane rather than folded into the scheduler's (ISS-988 criterion 20)
  it("draws the third run lane apart from the two named ones", () => {
    render(<QualitySection quality={QUALITY} />);
    expect(screen.getByText("Everything else failed")).toBeTruthy();
    expect(screen.getByText("0 of 2")).toBeTruthy();
  });

  it("draws the pipeline with the fix loop carried in text", () => {
    render(<QualitySection quality={QUALITY} />);
    expect(screen.getByText(/loops back/)).toBeTruthy();
  });
});
