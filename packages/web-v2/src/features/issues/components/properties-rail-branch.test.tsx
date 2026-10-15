// @vitest-environment jsdom
//
// ISS-1133 — the Branch row prints the branch core's work-evidence gate counts, never the issue
// key, so the rail and a `NO_WORK_EVIDENCE` refusal cannot disagree about whether one is recorded.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueDetail } from "../types";
import { PropertiesRail } from "./properties-rail";

expect.extend(matchers);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("./inline-edit-cell", async () => {
  const actual = await vi.importActual<typeof import("./inline-edit-cell")>("./inline-edit-cell");
  return { ...actual, StatusEdit: () => <span>issue status</span> };
});

vi.mock("./landing-shape-control", () => ({ LandingShapeControl: () => <span>work lands</span> }));

vi.mock("./merge-marker-control", () => ({
  MergeMarkerControl: ({ mergedAt }: { mergedAt: string | null }) => (
    <button type="button">{mergedAt ? "Unmark" : "Mark merged"}</button>
  ),
}));

afterEach(cleanup);

const EMPTY_ISSUE = {
  id: "i1",
  displayId: "ISS-4",
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

function renderRail(over: Partial<IssueDetail> = {}) {
  render(
    <PropertiesRail
      issue={{ ...EMPTY_ISSUE, ...over } as IssueDetail}
      slug="p1"
      cost={undefined}
      deps={undefined}
      pending={false}
      onPatch={vi.fn()}
      onTransition={vi.fn()}
      onEditModules={undefined}
      canMarkMerged={false}
    />,
  );
}

const branchRow = () =>
  screen.getByText("Branch", { selector: "span.fg-caption" }).parentElement as HTMLElement;

describe("the rail's Branch row", () => {
  it.each([
    ["no branch", null],
    ["an absent field", undefined],
  ])("says none is recorded where the gate counts %s, and never prints the issue key", (_, recordedBranch) => {
    renderRail({ recordedBranch });
    const row = within(branchRow());
    expect(row.getByText("None recorded")).toBeInTheDocument();
    expect(row.queryByText("ISS-4")).toBeNull();
  });

  it("prints the branch the gate counts", () => {
    renderRail({ recordedBranch: "ISS-1133-r3-the-report-names-every-door" });
    const row = within(branchRow());
    expect(row.getByText("ISS-1133-r3-the-report-names-every-door")).toBeInTheDocument();
    expect(row.queryByText("None recorded")).toBeNull();
  });
});
