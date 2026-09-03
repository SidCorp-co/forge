// @vitest-environment jsdom
//
// ISS-903 — the two surfaces the issue names by name. Both render a StatusChip
// in the `session` domain, which ignored `label` and rendered its own
// SESSION_LABELS entry, so eight passing tests coexisted with a chip telling
// the reader to act on a gate whose own copy says no action is needed.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KanbanCard } from "@/design";
import { StatusCell } from "./issue-row-actions";
import type { IssueRow, PipelineHealth } from "../types";

expect.extend(matchers);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../hooks", () => ({ useIssueDeps: () => ({ data: undefined }) }));

afterEach(cleanup);

const QUEUED_AT = "2026-09-03T14:43:00.000Z";

const health = (reason: PipelineHealth["waitingOn"] extends undefined ? never : string) =>
  ({
    stage: "in_progress",
    queuedAt: QUEUED_AT,
    queuedStep: {
      jobId: "a872c0b8",
      jobType: "drive",
      stageStatus: "open",
      queuedAt: QUEUED_AT,
      retryAfterAt: null,
    },
    waitingOn: { reason, since: QUEUED_AT, details: {} },
  }) as PipelineHealth;

const row = (
  pipelineHealth?: PipelineHealth,
  agentStatus: IssueRow["agentStatus"] = null,
): IssueRow =>
  ({
    id: "i",
    projectId: "p",
    issSeq: 903,
    displayId: "ISS-903",
    title: "A queued issue",
    description: null,
    status: "in_progress",
    priority: "high",
    category: null,
    complexity: null,
    assigneeId: null,
    createdById: "u",
    creatorEmail: null,
    creatorIsAgent: true,
    creatorLabel: "Forge Agent",
    reopenCount: 0,
    mergedAt: null,
    createdAt: QUEUED_AT,
    updatedAt: QUEUED_AT,
    agentStatus,
    ...(pipelineHealth ? { pipelineHealth } : {}),
  }) as IssueRow;

describe("issue list row · queued chip", () => {
  it("names the gate on the chip, never the interactive-chat copy", () => {
    render(<StatusCell row={row(health("runner_stale"))} />);
    expect(screen.getByText("No runner online")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for me")).not.toBeInTheDocument();
  });

  it("says Queued when nothing is holding the step", () => {
    const h = health("runner_stale");
    delete (h as { waitingOn?: unknown }).waitingOn;
    render(<StatusCell row={row(h)} />);
    expect(screen.getByText("Queued")).toBeInTheDocument();
  });

  it("shows the gate on a deferred retry, whose agentStatus reads `failed`", () => {
    render(<StatusCell row={row(health("runner_stale"), "failed")} />);
    expect(screen.getByText("No runner online")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("renders no queued chip for a row with no queued step", () => {
    render(<StatusCell row={row()} />);
    expect(screen.queryByText("Queued")).not.toBeInTheDocument();
    expect(screen.queryByText("Waiting for me")).not.toBeInTheDocument();
  });

  it("drops the running sweep from the mini tracker while a step is queued", () => {
    const { container, unmount } = render(<StatusCell row={row(health("runner_stale"))} />);
    expect(container.querySelector(".forge-indeterminate")).toBeNull();
    unmount();
    const live = render(<StatusCell row={row()} />);
    expect(live.container.querySelector(".forge-indeterminate")).not.toBeNull();
  });
});

describe("board card · queued chip", () => {
  it("carries the gate reason instead of the run's Running", () => {
    render(
      <KanbanCard
        id="ISS-903"
        title="A queued issue"
        stage="code"
        status="waiting"
        statusDomain="session"
        statusLabel="No runner online"
        waitingReason="No runner is online for this project."
      />,
    );
    expect(screen.getByText("No runner online")).toBeInTheDocument();
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    expect(screen.queryByText("Waiting for me")).not.toBeInTheDocument();
  });

  it("reaches the reason without opening the drawer", () => {
    render(
      <KanbanCard
        id="ISS-903"
        title="A queued issue"
        stage="code"
        status="waiting"
        statusDomain="session"
        statusLabel="No runner online"
        waitingReason="No runner is online for this project."
      />,
    );
    expect(
      screen.getByRole("button", { name: /waiting: No runner is online for this project\./ }),
    ).toBeInTheDocument();
  });
});
