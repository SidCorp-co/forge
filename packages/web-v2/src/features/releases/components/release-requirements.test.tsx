// REQ-35 BC-9: a release shows each requirement as a bar of criteria passed. Before ISS-463 the
// release page listed each requirement as text ("Moves BC-1.", "Not yet passing: BC-2."), so its
// progress had to be read rather than seen. Each requirement now draws its own criteria as one bar
// out of its total, labelled for a screen reader, and the text no longer repeats what the bar says.

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import type { ReleaseDetail, ReleaseRequirementView } from "../types";
import { OverviewPane } from "./release-panes";

const requirement = (key: string, coverage: ReleaseRequirementView["coverage"], over: Partial<ReleaseRequirementView> = {}): ReleaseRequirementView => ({
  key,
  title: `Requirement ${key}`,
  state: "in_delivery",
  completes: false,
  advances: [{ code: "BC-1", verdict: "passing" }],
  remaining: { issues: [], criteria: ["BC-2", "BC-3"] },
  coverage,
  ...over,
});

const release = (requirementsCompleted: ReleaseRequirementView[]) =>
  ({
    key: "0.1.0",
    version: "0.1.0",
    state: "draft",
    verified: { level: "none", proven: 0, total: 0, check: null, provider: null },
    issues: [],
    gates: [],
    requirementsCompleted,
    feedbackAnswered: [],
    notes: { sections: [], designs: [], withoutNotes: [], language: "en", attention: [] },
    changes: { surfaces: [], risks: [], unclassified: [], boxRead: [], shipsNothing: false },
  }) as unknown as ReleaseDetail;

function rows() {
  return screen.getAllByTestId("release-requirement");
}
const bar = (row: HTMLElement) => within(row).getByRole("img");
const widths = (row: HTMLElement) => [...bar(row).children].map((s) => (s as HTMLElement).style.width);

describe("a release draws each requirement as a bar of criteria passed", () => {
  it("gives every requirement its own bar, read passed out of that requirement's total", () => {
    renderWithQuery(
      <OverviewPane
        r={release([requirement("REQ-1", { criteria: 4, passing: 1, judged: 2 }), requirement("REQ-2", { criteria: 14, passing: 0, judged: 0 })])}
        slug="hop"
        all={[]}
      />,
    );
    const [one, two] = rows() as [HTMLElement, HTMLElement];
    expect(within(one).getByTestId("requirement-criteria").textContent).toContain("1/4 criteria passing");
    expect(within(two).getByTestId("requirement-criteria").textContent).toContain("0/14 criteria passing");
    expect(widths(one)).toEqual(["25%", "25%", "50%"]);
    expect(widths(two)).toEqual(["100%"]);
  });

  it("names each segment and its count for a screen reader", () => {
    renderWithQuery(<OverviewPane r={release([requirement("REQ-1", { criteria: 4, passing: 1, judged: 2 })])} slug="hop" all={[]} />);
    expect(bar(rows()[0] as HTMLElement).getAttribute("aria-label")).toBe("Passing 1, Failing 1, Not judged yet 2");
  });

  it("grows the passing segment by one criterion when one moves from not judged to pass", () => {
    const { unmount } = renderWithQuery(<OverviewPane r={release([requirement("REQ-1", { criteria: 3, passing: 1, judged: 1 })])} slug="hop" all={[]} />);
    const before = bar(rows()[0] as HTMLElement);
    expect(before.getAttribute("aria-label")).toBe("Passing 1, Not judged yet 2");
    const passingBefore = Number.parseFloat((before.children[0] as HTMLElement).style.width);
    unmount();
    renderWithQuery(<OverviewPane r={release([requirement("REQ-1", { criteria: 3, passing: 2, judged: 2 })])} slug="hop" all={[]} />);
    const after = bar(rows()[0] as HTMLElement);
    expect(after.getAttribute("aria-label")).toBe("Passing 2, Not judged yet 1");
    expect(within(rows()[0] as HTMLElement).getByTestId("requirement-criteria").textContent).toContain("2/3 criteria passing");
    expect(Number.parseFloat((after.children[0] as HTMLElement).style.width) - passingBefore).toBeCloseTo(100 / 3);
  });

  it("no longer lists the not-yet-passing codes as text beside the bar", () => {
    renderWithQuery(<OverviewPane r={release([requirement("REQ-1", { criteria: 3, passing: 1, judged: 1 })])} slug="hop" all={[]} />);
    const row = rows()[0] as HTMLElement;
    expect(row.textContent).toContain("Moves BC-1.");
    expect(row.textContent).not.toContain("BC-2");
    expect(row.textContent).not.toContain("Not yet passing");
  });

  it("says a requirement with no criteria has none rather than drawing an empty bar", () => {
    renderWithQuery(<OverviewPane r={release([requirement("REQ-1", { criteria: 0, passing: 0, judged: 0 })])} slug="hop" all={[]} />);
    const row = rows()[0] as HTMLElement;
    expect(within(row).queryByRole("img")).toBeNull();
    expect(row.textContent).toContain("No criteria recorded");
  });
});
