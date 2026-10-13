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

  it("labels a running run with its step", () => {
    render(<LiveRunsCard runs={[run("running")]} slug="forge-dev" />);
    expect(screen.getByText("running · drive")).toBeInTheDocument();
  });

  it("names the runs read while it is out and states no run, none live and no idle count", () => {
    render(<LiveRunsCard runs={[]} idle={[run("running")]} slug="forge-dev" read={{ read: "pending" }} />);
    expect(screen.getByText("The project's runs are still being read.")).toBeInTheDocument();
    expect(screen.queryByText(/none live/)).toBeNull();
    expect(screen.queryByText(/no job running/)).toBeNull();
  });

  it("names why the runs read failed", () => {
    render(<LiveRunsCard runs={[]} slug="forge-dev" read={{ read: "failed", reason: "Gateway Timeout" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The project's runs could not be read: Gateway Timeout");
  });

  it("states the zero once the read is in", () => {
    render(<LiveRunsCard runs={[]} slug="forge-dev" read={{ read: "ok" }} />);
    expect(screen.getByText("none live right now")).toBeInTheDocument();
  });
});
