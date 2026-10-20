// @vitest-environment jsdom
//
// Per-file jsdom opt-in: web-v2's vitest config stays `environment: 'node'`
// globally and matchers are extended on vitest's OWN `expect` — see the
// docblock on project-dashboard/awaiting-release-card.test.tsx for why.
//
// The UX contract's required states are asserted here rather than eyeballed,
// and so is the VISION §5 boundary: this surface must carry nothing typeable.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityTab } from "./activity-feed";
import type { PipelineRunAttempt, PipelineRunSummary } from "../types";

expect.extend(matchers);
afterEach(cleanup);

function attempt(over: Partial<PipelineRunAttempt> = {}): PipelineRunAttempt {
  return {
    jobId: `job-${Math.random().toString(36).slice(2)}`,
    jobType: "code",
    status: "failed",
    attempts: 1,
    retryOf: null,
    deviceId: "dev-1",
    deviceName: "ubuntu5",
    failureReason: null,
    failureCause: "provider_spend_cap",
    failureDetail: null,
    failureKind: null,
    failureAction: null,
    queuedAt: "2026-08-30T10:00:00.000Z",
    startedAt: "2026-08-30T10:00:05.000Z",
    ranAt: "2026-08-30T10:00:06.000Z",
    finishedAt: "2026-08-30T10:01:00.000Z",
    autoRetry: null,
    takenBy: null,
    ...over,
  };
}

function run(attempts: PipelineRunAttempt[]): PipelineRunSummary {
  return {
    id: "run-1",
    projectId: "proj-1",
    issueId: null,
    lane: "system",
    group: { source: "none", issues: [], detail: "this run was not opened over a group of issues" },
    issueRef: null,
    issueTitle: null,
    kind: "issue",
    status: "running",
    currentStep: "code",
    startedAt: "2026-08-30T10:00:00.000Z",
    finishedAt: null,
    steps: [],
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
    reading: null,
    attempts,
    retrySummary: null,
    gateAtOpen: null,
  };
}

const noop = () => {};

describe("ActivityTab — required states", () => {
  it("loading: renders placeholders, not an empty panel", () => {
    const { container } = render(
      <ActivityTab run={undefined} loading error={null} onRetry={noop} />,
    );
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });

  it("error: states the failure and offers Retry", () => {
    const onRetry = vi.fn();
    render(
      <ActivityTab run={undefined} loading={false} error={new Error("boom")} onRetry={onRetry} />,
    );
    const retry = screen.getByRole("button", { name: /retry/i });
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("first-run empty: says what will appear here, in a box's name rather than a runner's", () => {
    const opened = { ...run([]), startedAt: new Date().toISOString() };
    render(<ActivityTab run={opened} loading={false} error={null} onRetry={noop} />);
    expect(screen.getByText(/nothing has run yet/i)).toBeInTheDocument();
    expect(screen.getByText("Attempts appear here the moment a box picks this up.")).toBeInTheDocument();
  });

  // ISS-1228 round 18 repair: a run reading Nothing working promised attempts "the moment a runner
  // picks this up", though no job waited for any box.
  it("a run nothing works and nothing waits on: says so, and promises no attempt", () => {
    render(<ActivityTab run={run([])} loading={false} error={null} onRetry={noop} />);
    expect(screen.getByText("Nothing is working this run")).toBeInTheDocument();
    expect(screen.queryByText(/the moment a/)).toBeNull();
  });

  // ISS-1228 round 18: a run session's drawer read Running over "Nothing has run yet".
  it.each(["running", "waiting"] as const)(
    "a %s run with no job: says a session works it, never that nothing has run",
    (reading) => {
      render(
        <ActivityTab run={{ ...run([]), reading }} loading={false} error={null} onRetry={noop} />,
      );
      expect(screen.getByText("No job attempts")).toBeInTheDocument();
      expect(screen.queryByText(/nothing has run yet/i)).toBeNull();
    },
  );

  it("no pipeline run: says there is none rather than that nothing has run", () => {
    render(<ActivityTab run={undefined} loading={false} error={null} onRetry={noop} />);
    expect(screen.getByText("No pipeline run")).toBeInTheDocument();
    expect(screen.queryByText(/nothing has run yet/i)).toBeNull();
  });

  it("filtered-empty is DISTINCT from first-run empty and clears the filter", () => {
    render(
      <ActivityTab
        run={run([attempt({ status: "done", failureCause: null })])}
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Failures" }));
    expect(screen.getByText(/no failures/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing has run yet/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /show all/i }));
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });
});

describe("ActivityTab — the defect itself", () => {
  it("shows 16 identical failures as ONE counted line", () => {
    const rows = Array.from({ length: 16 }, () => attempt());
    render(<ActivityTab run={run(rows)} loading={false} error={null} onRetry={noop} />);

    expect(screen.getAllByText("Spend limit reached")).toHaveLength(1);
    expect(screen.getByText("×16")).toBeInTheDocument();
  });

  it("keeps two different causes readable as two different lines", () => {
    render(
      <ActivityTab
        run={run([attempt(), attempt({ failureCause: "workspace_disk_full" })])}
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    expect(screen.getByText("Spend limit reached")).toBeInTheDocument();
    expect(screen.getByText("Runner disk full")).toBeInTheDocument();
    expect(screen.getByText(/2 distinct causes/i)).toBeInTheDocument();
  });

  it("renders a raw-token-free label for an unclassified death", () => {
    render(
      <ActivityTab
        run={run([attempt({ failureCause: "job_failed" })])}
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    expect(screen.getByText("Unclassified")).toBeInTheDocument();
    expect(screen.queryByText("job_failed")).not.toBeInTheDocument();
  });
});

describe("ActivityTab — VISION §5 boundary", () => {
  it("carries nothing typeable: no input, no textarea, no contenteditable", () => {
    const { container } = render(
      <ActivityTab run={run([attempt()])} loading={false} error={null} onRetry={noop} />,
    );
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("[contenteditable]")).toBeNull();
  });

  it("the filter is reachable as real buttons, so it is keyboard-operable", () => {
    render(<ActivityTab run={run([attempt()])} loading={false} error={null} onRetry={noop} />);
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Failures" })).toBeInTheDocument();
  });
});

describe("the collapsed-repeat badge is reachable without a mouse", () => {
  it("names which attempts folded, without needing a pointer", () => {
    render(
      <ActivityTab
        run={run([attempt(), attempt(), attempt()])}
        loading={false}
        error={null}
        onRetry={() => {}}
      />,
    );
    const note = screen.getByText("Attempts 1, 2, 3 were identical.");
    expect(note).toHaveClass("sr-only");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

// ISS-1228 round 19 (judge-57): a closed run with no attempt still promised attempts would appear.
describe("a closed run's activity promises nothing", () => {
  it("says nothing ran on a closed run with no attempt and no session", () => {
    render(
      <ActivityTab run={{ ...run([]), status: "failed", finishedAt: "2026-08-30T10:10:00.000Z" }} loading={false} error={null} onRetry={noop} />,
    );
    expect(screen.getByText("Nothing ran on this run")).toBeInTheDocument();
    expect(screen.queryByText(/Attempts appear here/)).toBeNull();
  });

  it("says a session worked a closed run session, linking its page", () => {
    render(
      <ActivityTab
        run={{ ...run([]), lane: "run_session", status: "failed", finishedAt: "2026-08-30T10:10:00.000Z", sessionId: "s7", runningSince: "2026-08-30T10:01:00.000Z" }}
        sessionHref="/projects/qa/agents/s7"
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    expect(screen.queryByText(/Attempts appear here/)).toBeNull();
    expect(screen.getByRole("link", { name: "Its session's page shows what it did." })).toHaveAttribute(
      "href",
      "/projects/qa/agents/s7",
    );
  });

  it("says nothing ran on a closed run whose session never checked in, never that a session worked it", () => {
    render(
      <ActivityTab
        run={{ ...run([]), lane: "run_session", status: "failed", finishedAt: "2026-08-30T10:10:00.000Z", sessionId: "s7", runningSince: null }}
        sessionHref="/projects/qa/agents/s7"
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    expect(screen.getByText("Nothing ran on this run")).toBeInTheDocument();
    expect(screen.queryByText(/A session worked this run/)).toBeNull();
    expect(screen.getByRole("link", { name: "Its session's page shows how it ended." })).toBeInTheDocument();
  });

  it("says a run session that has not checked in has not started, never that it worked the run", () => {
    render(
      <ActivityTab
        run={{ ...run([]), lane: "run_session", reading: "starting", sessionId: "s7", runningSince: null }}
        sessionHref="/projects/qa/agents/s7"
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    expect(screen.getByText("Not started yet")).toBeInTheDocument();
    expect(screen.queryByText(/A session worked this run/)).toBeNull();
  });

  it("links the session's page from an open run its session works", () => {
    render(
      <ActivityTab
        run={{ ...run([]), lane: "run_session", reading: "running", sessionId: "s7" }}
        sessionHref="/projects/qa/agents/s7"
        loading={false}
        error={null}
        onRetry={noop}
      />,
    );
    expect(screen.getByRole("link", { name: "Its session's page shows what it is doing." })).toBeInTheDocument();
    // ISS-1228 round 21 (judge-67): a live run's drawer said its session "worked" it.
    expect(
      screen.getByText("A session is working this run directly rather than through jobs, so there are no attempts to list."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/A session worked this run/)).toBeNull();
  });
});
