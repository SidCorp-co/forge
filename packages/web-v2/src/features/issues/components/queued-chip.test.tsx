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

  // cm:guard ISS-903's rule, re-anchored by ISS-999: the cell used to carry a mini tracker whose indeterminate sweep had to be suppressed while a step sat queued, and the tracker is gone. The rule survives on the chips — an `in_progress` issue with nothing dispatched shows its lifecycle label and the gate, and NOTHING claiming a live session.
  it("adds no session chip while a step is only queued", () => {
    const { container } = render(<StatusCell row={row(health("runner_stale"))} />);
    expect(screen.getByText("No runner online")).toBeInTheDocument();
    // cm:why one "Running" and not zero — the issue's own lifecycle label, which is true, since it IS at `in_progress`; what must be absent is a SECOND chip claiming a live session
    expect(screen.getAllByText("Running")).toHaveLength(1);
    expect(container.querySelector(".forge-indeterminate")).toBeNull();
  });

  it("adds the session chip on a row that IS being worked", () => {
    render(<StatusCell row={row(undefined, "running")} />);
    // cm:why two — the lifecycle label and the live agent's own session chip beside it, which is the ISS-436 split this row's cell exists to keep
    expect(screen.getAllByText("Running")).toHaveLength(2);
    expect(screen.queryByText("Queued")).not.toBeInTheDocument();
  });

  it("renders no progress figure on any row, queued or live", () => {
    const { container, unmount } = render(<StatusCell row={row(health("runner_stale"))} />);
    expect(container.textContent).not.toMatch(/\d+\s*\/\s*7/);
    unmount();
    const live = render(<StatusCell row={row(undefined, "running")} />);
    expect(live.container.textContent).not.toMatch(/\d+\s*\/\s*7/);
  });
});

describe("board card · queued chip", () => {
  it("carries the gate reason instead of the run's Running", () => {
    render(
      <KanbanCard
        id="ISS-903"
        title="A queued issue"
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
