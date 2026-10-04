// @vitest-environment jsdom
//
// ISS-1277 — a paused pipeline run says Paused. The session vocabulary reads `paused` as an idle
// session, which is not what a paused run is.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineRunListItem } from "@/features/pipeline/types";
import { LiveRunsCard } from "./live-runs-card";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }));

const run = (status: "running" | "paused"): PipelineRunListItem =>
  ({
    id: `r-${status}`,
    projectId: "p1",
    issueId: "i1",
    issueRef: "ISS-2",
    issueTitle: "An issue",
    kind: "issue",
    status,
    currentStep: "drive",
    startedAt: "2026-09-05T14:16:00Z",
    finishedAt: null,
  }) as unknown as PipelineRunListItem;

describe("the live runs card", () => {
  it("labels a paused run Paused, never Idle", () => {
    render(<LiveRunsCard runs={[run("paused")]} slug="forge-dev" />);
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.queryByText("Idle")).toBeNull();
  });

  it("labels a running run through the pipelineRun badge, with its step beside it", () => {
    render(<LiveRunsCard runs={[run("running")]} slug="forge-dev" />);
    expect(screen.getByTestId("status-badge")).toHaveAttribute("data-value", "running");
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Drive")).toBeInTheDocument();
  });
});
