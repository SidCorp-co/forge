// @vitest-environment jsdom
//
// ISS-1150 — an empty field earns its row or loses it. A field with nothing in it and nothing the
// reader can do about it renders no row; the empty fields a writer can act on share one `Not set`
// row; and the run's state is its own `Run` row, never folded into the issue's `Status`.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueCostSummary, IssueDetail } from "../types";
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
  opts: { writer?: boolean; cost?: IssueCostSummary } = {},
) {
  render(
    <PropertiesRail
      issue={{ ...EMPTY_ISSUE, ...over } as IssueDetail}
      slug="p1"
      cost={opts.cost}
      deps={undefined}
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
});
