// @vitest-environment jsdom
//
// ISS-1150 — an empty field earns its row or loses it. A field with nothing in it and nothing the
// reader can do about it renders no row; the empty fields a writer can act on share one `Not set`
// row; and the run's state is its own `Run` row, never folded into the issue's `Status`.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueCostSummary, IssueDependencies, IssueDetail } from "../types";
import { PropertiesRail } from "./properties-rail";

expect.extend(matchers);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("./inline-edit-cell", async () => {
  const actual = await vi.importActual<typeof import("./inline-edit-cell")>("./inline-edit-cell");
  return { ...actual, StatusEdit: () => <span>issue status</span> };
});

vi.mock("./merge-marker-control", () => ({
  MergeMarkerControl: ({ mergedAt }: { mergedAt: string | null }) => (
    <button type="button">{mergedAt ? "Unmark" : "Mark merged"}</button>
  ),
}));

afterEach(cleanup);

const EMPTY_ISSUE = {
  id: "i1",
  displayId: "ISS-1150",
  status: "open",
  agentStatus: null,
  priority: "medium",
  complexity: "m",
  category: null,
  labels: [],
  mergedAt: null,
  createdAt: "2026-09-21T11:01:17.765Z",
  reopenCount: 0,
} as unknown as IssueDetail;

const COST: IssueCostSummary = {
  estimatedCost: 1.5,
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
} as IssueCostSummary;

function renderRail(
  over: Partial<IssueDetail> = {},
  opts: { writer?: boolean; cost?: IssueCostSummary; deps?: IssueDependencies } = {},
) {
  render(
    <PropertiesRail
      issue={{ ...EMPTY_ISSUE, ...over } as IssueDetail}
      slug="p1"
      cost={opts.cost}
      deps={opts.deps}
      pending={false}
      onPatch={vi.fn()}
      onTransition={vi.fn()}
      onEditModules={opts.writer ? vi.fn() : undefined}
      canMarkMerged={opts.writer ?? false}
    />,
  );
}

const rowLabel = (label: string) => screen.queryByText(label, { selector: "span.fg-caption" });

describe("the rail's empty fields", () => {
  it("renders no row for a field with no value and no action for this reader", () => {
    renderRail();
    for (const label of ["Category", "Module", "Merged", "Cost", "Tokens", "Not set"]) {
      expect(rowLabel(label)).toBeNull();
    }
    expect(screen.queryByText("—")).toBeNull();
  });

  it("gives a writer one Not set row holding each empty field's own action", () => {
    renderRail({}, { writer: true });
    const row = rowLabel("Not set")?.parentElement;
    expect(row).toBeTruthy();
    const scoped = within(row as HTMLElement);
    expect(scoped.getByRole("button", { name: "Set module" })).toBeInTheDocument();
    expect(scoped.getByRole("button", { name: "Mark merged" })).toBeInTheDocument();
    expect(rowLabel("Module")).toBeNull();
    expect(rowLabel("Merged")).toBeNull();
  });

  it("keeps a field's row once it holds a value, and drops it from Not set", () => {
    renderRail(
      {
        category: "bug",
        mergedAt: "2026-09-20T14:59:37.646Z",
        labels: [{ id: "m1", name: "web-v2", kind: "module", isPrimary: true }],
      } as Partial<IssueDetail>,
      { writer: true, cost: COST },
    );
    for (const label of ["Category", "Module", "Merged", "Cost", "Tokens"]) {
      expect(rowLabel(label)).toBeInTheDocument();
    }
    expect(screen.getByText("$1.50")).toBeInTheDocument();
    expect(screen.getByText("1.5K")).toBeInTheDocument();
    expect(rowLabel("Not set")).toBeNull();
  });
});

describe("the rail's two statuses", () => {
  it("shows no Run row when no run has a state", () => {
    renderRail();
    expect(rowLabel("Status")).toBeInTheDocument();
    expect(rowLabel("Run")).toBeNull();
  });

  it.each([
    ["queued", "Queued"],
    ["running", "Running"],
    ["completed", "Completed"],
    ["failed", "Failed"],
  ] as const)("shows a %s run on its own Run row, apart from the issue status", (agentStatus, word) => {
    renderRail({ agentStatus });
    const run = rowLabel("Run")?.parentElement as HTMLElement;
    expect(within(run).getByText(word)).toBeInTheDocument();
    const status = rowLabel("Status")?.parentElement as HTMLElement;
    expect(within(status).queryByText(word)).toBeNull();
  });

  // ISS-1277 — a job no runner has claimed has no session, and is still a queued run.
  const queuedJob = {
    stage: "open",
    queuedStep: { jobId: "j1", jobType: "drive", stageStatus: null, queuedAt: "2026-09-05T14:16:00Z", retryAfterAt: null },
  };

  it.each([
    ["no session", null],
    ["a failed session", "failed"],
    ["a completed session", "completed"],
  ] as const)("shows a job queued with %s as a Queued run", (_, agentStatus) => {
    renderRail({ agentStatus, pipelineHealth: queuedJob });
    const run = rowLabel("Run")?.parentElement as HTMLElement;
    expect(within(run).getByText("Queued")).toBeInTheDocument();
  });

  it("shows no Run row when the pipeline has nothing queued and no session exists", () => {
    renderRail({ agentStatus: null, pipelineHealth: { stage: "open" } });
    expect(rowLabel("Run")).toBeNull();
  });
});

describe("the rail's relations", () => {
  const edge = (id: string, fromDisplayId: string, expired: boolean) => ({
    id,
    fromIssueId: `f-${id}`,
    toIssueId: "i1",
    kind: "blocks" as const,
    reason: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    fromDisplayId,
    fromTitle: "a blocker",
    fromStatus: "in_progress" as const,
    expired,
  });

  it("lists a retracted edge greyed under Expired, and never under Blocked by", () => {
    renderRail({}, { deps: { incoming: [edge("gone", "ISS-8", true)], outgoing: [] } });
    expect(screen.queryByText("Blocked by")).toBeNull();
    const expired = screen.getByText("Expired").parentElement as HTMLElement;
    expect(expired).toHaveAttribute("data-expired", "true");
    expect(within(expired).getByText("blocks ISS-8 · expired")).toBeInTheDocument();
  });

  it("keeps a live edge under Blocked by beside a retracted one", () => {
    renderRail(
      {},
      { deps: { incoming: [edge("gone", "ISS-8", true), edge("live", "ISS-9", false)], outgoing: [] } },
    );
    const blocked = screen.getByText("Blocked by").parentElement as HTMLElement;
    expect(within(blocked).queryByText(/ISS-8/)).toBeNull();
    expect(within(blocked).getByText(/ISS-9/)).toBeInTheDocument();
  });
});
