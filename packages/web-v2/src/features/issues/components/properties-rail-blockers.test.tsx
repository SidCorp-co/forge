// @vitest-environment jsdom
//
// ISS-1228 — the rail says an issue is blocked only by a blocker that still holds it. A blocker that
// has settled (closed, or at a status that releases its dependent) is listed as one that was, never
// under "Blocked by".

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueDependencies, IssueDependencyEdge, IssueDetail } from "../types";
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
vi.mock("./merge-marker-control", () => ({ MergeMarkerControl: () => <button type="button">Mark merged</button> }));

afterEach(cleanup);

const ISSUE = {
  id: "i1228",
  displayId: "ISS-1228",
  status: "developed",
  agentStatus: null,
  priority: "medium",
  complexity: "l",
  category: null,
  labels: [],
  mergedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  reopenCount: 0,
} as unknown as IssueDetail;

const blocker = (over: Partial<IssueDependencyEdge>): IssueDependencyEdge => ({
  id: "e",
  fromIssueId: "b",
  toIssueId: "i1228",
  kind: "blocks",
  reason: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  fromDisplayId: "ISS-1135",
  fromTitle: "the blocker",
  fromStatus: "closed",
  toDisplayId: "ISS-1228",
  toTitle: "this issue",
  toStatus: "developed",
  ...over,
});

function renderRail(incoming: IssueDependencyEdge[]) {
  const deps: IssueDependencies = { incoming, outgoing: [] };
  render(
    <PropertiesRail
      issue={ISSUE}
      slug="forge-dev"
      cost={undefined}
      deps={deps}
      pending={false}
      onPatch={vi.fn()}
      onTransition={vi.fn()}
    />,
  );
}

const heading = (label: string) => screen.queryByText(label, { selector: "p.fg-caption" });

describe("the rail's blockers", () => {
  it("does not say an issue is blocked by a blocker that has closed", () => {
    renderRail([blocker({})]);
    expect(heading("Blocked by")).toBeNull();
    expect(heading("Was blocked by")).toBeInTheDocument();
    expect(heading("Was blocked by")?.parentElement).toHaveTextContent("ISS-1135");
  });

  it("lists a blocker that still holds the issue under Blocked by, and one that settled apart from it", () => {
    renderRail([
      blocker({ id: "open", fromIssueId: "b1", fromDisplayId: "ISS-9", fromStatus: "in_progress" }),
      blocker({ id: "done", fromIssueId: "b2", fromDisplayId: "ISS-1135", fromStatus: "closed" }),
    ]);
    const blocked = heading("Blocked by")?.parentElement;
    const was = heading("Was blocked by")?.parentElement;
    expect(blocked).toHaveTextContent("ISS-9");
    expect(blocked).not.toHaveTextContent("ISS-1135");
    expect(was).toHaveTextContent("ISS-1135");
    expect(was).not.toHaveTextContent("ISS-9");
  });

  it("keeps a blocker held until it ships under Blocked by while it is only developed", () => {
    renderRail([blocker({ fromStatus: "developed", holdsUntil: "shipped" })]);
    expect(heading("Blocked by")).toBeInTheDocument();
    expect(heading("Was blocked by")).toBeNull();
  });
});
