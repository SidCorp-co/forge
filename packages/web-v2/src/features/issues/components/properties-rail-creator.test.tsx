// @vitest-environment jsdom
//
// ISS-1229 r21, judge-62: the issue page's Creator field is a label, so it shows what core calls the
// creator — the display name, else "Another member" — and never the address the payload also carries.

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueDetail } from "../types";
import { PropertiesRail } from "./properties-rail";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("./inline-edit-cell", async () => {
  const actual = await vi.importActual<typeof import("./inline-edit-cell")>("./inline-edit-cell");
  return { ...actual, StatusEdit: () => <span>issue status</span> };
});
vi.mock("./landing-shape-control", () => ({ LandingShapeControl: () => <span>work lands</span> }));
vi.mock("./merge-marker-control", () => ({ MergeMarkerControl: () => <span>merge</span> }));

afterEach(cleanup);

const issue = (creatorLabel: string) =>
  ({
    id: "i1",
    displayId: "ISS-1",
    status: "open",
    agentStatus: null,
    priority: "medium",
    complexity: "m",
    category: null,
    labels: [],
    mergedAt: null,
    createdAt: "2026-09-21T11:01:17.765Z",
    reopenCount: 0,
    createdById: "u1",
    creatorEmail: "lan.pham@example.com",
    creatorIsAgent: false,
    creatorLabel,
  }) as unknown as IssueDetail;

function creatorRow(creatorLabel: string): HTMLElement {
  const { container } = render(
    <PropertiesRail
      issue={issue(creatorLabel)}
      slug="p1"
      cost={undefined}
      deps={undefined}
      pending={false}
      onPatch={vi.fn()}
      onTransition={vi.fn()}
      canMarkMerged={false}
    />,
  );
  expect(container.textContent).not.toContain("lan.pham@example.com");
  return screen.getByText("Creator").parentElement as HTMLElement;
}

describe("the issue page's Creator field", () => {
  it("shows Another member, with its initials, for a creator with no display name", () => {
    const row = creatorRow("Another member");
    expect(within(row).getByText("Another member")).toBeTruthy();
    expect(within(row).getByText("AM")).toBeTruthy();
  });

  it("shows the display name for a creator who gave one", () => {
    const row = creatorRow("Lan Pham");
    expect(within(row).getByText("Lan Pham")).toBeTruthy();
    expect(within(row).getByText("LP")).toBeTruthy();
  });
});
