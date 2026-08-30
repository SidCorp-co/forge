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
    finishedAt: "2026-08-30T10:01:00.000Z",
    autoRetry: null,
    ...over,
  };
}

function run(attempts: PipelineRunAttempt[]): PipelineRunSummary {
  return {
    id: "run-1",
    projectId: "proj-1",
    issueId: null,
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
    attempts,
    retrySummary: null,
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

  it("first-run empty: says what will appear here", () => {
    render(<ActivityTab run={run([])} loading={false} error={null} onRetry={noop} />);
    expect(screen.getByText(/nothing has run yet/i)).toBeInTheDocument();
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
