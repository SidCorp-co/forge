// A release leads with what users get; the engineers' detail stays behind a toggle, each reason said once.

import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import type { ReleaseDetail } from "../types";
import { presentSteps } from "@/features/tours/run-tour";
import { tourById } from "@/features/tours/registry";
import { OverviewPane } from "./release-panes";

const unclassified = Array.from({ length: 40 }, (_, i) => ({
  key: `ISS-${100 + i}`,
  why: "its landing is text that names no artifact: it was marked before a landing named what it changed",
  paths: [],
}));
const release = {
  key: "0.1.0",
  version: "0.1.0",
  state: "draft",
  issues: [],
  gates: [],
  requirementsCompleted: [],
  notes: {
    sections: [
      { section: "Added", entries: [{ key: "ISS-94", title: "Saved boards keep every card", userFacing: "A saved board shows every card it had.", technical: null }] },
      { section: "Fixed", entries: [{ key: "ISS-98", title: "Export no longer fails", userFacing: "Exporting a board works again.", technical: null }] },
    ],
    withoutNotes: [{ key: "ISS-101", title: "Rename a helper" }],
  },
  changes: { surfaces: [], risks: [], unclassified, boxRead: [], shipsNothing: false },
} as unknown as ReleaseDetail;

describe("a release leads with what users get", () => {
  it("reads the user notes by title under their sections before any engineering detail", () => {
    renderWithQuery(<OverviewPane r={release} slug="hop" all={[]} />);
    const body = screen.getByTestId("view-overview");
    const sections = within(body).getAllByTestId("release-users-section");
    expect(sections.map((s) => s.getAttribute("data-section"))).toEqual(["Added", "Fixed"]);
    expect(within(sections[0] as HTMLElement).getByText("Saved boards keep every card")).toBeTruthy();
    const order = [...body.querySelectorAll("[data-testid='release-users-get'],[data-testid='release-technical']")].map((n) => n.getAttribute("data-testid"));
    expect(order).toEqual(["release-users-get", "release-technical"]);
  });

  it("keeps the engineering detail collapsed and says each unclassified reason once with a count", () => {
    renderWithQuery(<OverviewPane r={release} slug="hop" all={[]} />);
    expect(screen.queryByTestId("release-changes")).toBeNull();
    fireEvent.click(screen.getByTestId("release-technical-toggle"));
    const rows = screen.getAllByTestId("release-unclassified");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("40 issues");
    expect(rows[0]?.textContent).toContain("names no artifact");
  });
});

describe("the release tour on the overview with Technical detail closed", () => {
  const original = Element.prototype.getClientRects;
  afterEach(() => {
    Element.prototype.getClientRects = original;
  });

  it("finds every step's anchor, so Show me never skips a step in silence", () => {
    // jsdom lays nothing out; an element a closed section does not render has no box either way
    Element.prototype.getClientRects = function (this: Element) {
      return [this.getBoundingClientRect()] as unknown as DOMRectList;
    };
    renderWithQuery(<OverviewPane r={release} slug="hop" all={[]} />);
    const tour = tourById("release-what-changes");
    if (!tour) throw new Error("the release tour is not in the registry");
    expect(screen.queryByTestId("release-changes")).toBeNull();
    const { present, missing } = presentSteps(tour);
    expect(missing).toEqual([]);
    expect(present).toHaveLength(tour.steps.length);
  });
});
