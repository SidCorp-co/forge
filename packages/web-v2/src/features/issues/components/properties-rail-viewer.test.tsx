// @vitest-environment jsdom
//
// ISS-1229 r40, judge-111 at abdd0d7: a viewer read an issue's Priority ("Medium") and Complexity only
// in disabled dropdowns, at 3.32:1. A reader who cannot write reads them as text, in the default ink.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueDetail } from "../types";
import { PropertiesRail } from "./properties-rail";

expect.extend(matchers);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("./inline-edit-cell", async () => {
  const actual = await vi.importActual<typeof import("./inline-edit-cell")>("./inline-edit-cell");
  return { ...actual, StatusEdit: () => <span>status</span> };
});

vi.mock("./merge-marker-control", () => ({ MergeMarkerControl: () => null }));

afterEach(cleanup);

function rail(readOnly: boolean, over: Partial<IssueDetail> = {}) {
  const issue = {
    id: "i1",
    displayId: "ISS-1",
    status: "open",
    agentStatus: null,
    priority: "medium",
    complexity: "m",
    labels: [],
    mergedAt: null,
    ...over,
  } as unknown as IssueDetail;
  return render(
    <PropertiesRail
      issue={issue}
      slug="p1"
      cost={undefined}
      deps={undefined}
      pending={readOnly}
      readOnly={readOnly}
      onPatch={vi.fn()}
      onTransition={vi.fn()}
    />,
  );
}

describe("Priority and Complexity for a reader who cannot write", () => {
  it("reads them as text in the default ink, with no control to press", () => {
    rail(true);
    expect(screen.queryByRole("combobox", { name: "Priority" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Complexity" })).toBeNull();
    const priority = screen.getByTestId("read-priority");
    expect(priority).toHaveTextContent("Medium");
    expect(priority.className).toMatch(/\btext-fg\b/);
    expect(priority.className).not.toMatch(/\bfg-[a-z-]+\b|text-disabled|opacity/);
    expect(screen.getByTestId("read-complexity")).toHaveTextContent(/\S/);
  });

  it("says an unset complexity is not set", () => {
    rail(true, { complexity: null });
    expect(screen.getByTestId("read-complexity")).toHaveTextContent("Not set");
  });

  it("keeps the controls for a reader who can write", () => {
    rail(false);
    expect(screen.getByRole("combobox", { name: "Priority" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Complexity" })).toBeEnabled();
  });
});
