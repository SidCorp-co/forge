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
  verified: { level: "none", proven: 0, total: 0, check: null, provider: null },
  issues: [],
  gates: [],
  requirementsCompleted: [],
  feedbackAnswered: [],
  notes: {
    sections: [
      { section: "Added", entries: [{ key: "ISS-94", title: "Saved boards keep every card", userFacing: "A saved board shows every card it had.", technical: null }] },
      { section: "Fixed", entries: [{ key: "ISS-98", title: "Export no longer fails", userFacing: "Exporting a board works again.", technical: null }] },
    ],
    designs: [],
    withoutNotes: [{ key: "ISS-101", title: "Rename a helper" }],
    language: "vi",
    attention: [
      { key: "ISS-94", title: "Saved boards keep every card", notInLanguage: true, references: [] },
      { key: "ISS-98", title: "Export no longer fails", notInLanguage: true, references: ["commit sha 9db12a21a"] },
      { key: "ISS-99", title: "Rules", notInLanguage: false, references: ["code SOD-RULE-MAKER-CHECKER"] },
    ],
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
    // the user's sentence leads each entry; the issue title stands behind it (JU-11)
    expect(within(sections[0] as HTMLElement).getByTestId("release-users-sentence").textContent).toBe("A saved board shows every card it had.");
    const order = [...body.querySelectorAll("[data-testid='release-users-get'],[data-testid='release-technical']")].map((n) => n.getAttribute("data-testid"));
    expect(order).toEqual(["release-users-get", "release-technical"]);
  });

  it("says above the notes how many need attention, by cause, and links each", () => {
    renderWithQuery(<OverviewPane r={release} slug="hop" all={[]} />);
    const line = screen.getByTestId("release-notes-attention");
    expect(line.textContent).toContain("3 notes need attention before release: 2 not in Vietnamese, 2 carry technical references");
    expect(within(line).getAllByRole("link").map((a) => a.textContent)).toEqual(["ISS-94", "ISS-98", "ISS-99"]);
    const order = [...screen.getByTestId("view-overview").querySelectorAll("[data-testid='release-notes-attention'],[data-testid='release-users-section']")].map((n) => n.getAttribute("data-testid"));
    expect(order[0]).toBe("release-notes-attention");
  });

  it("shows no line when no note needs attention", () => {
    renderWithQuery(<OverviewPane r={{ ...release, notes: { ...release.notes, attention: [] } }} slug="hop" all={[]} />);
    expect(screen.queryByTestId("release-notes-attention")).toBeNull();
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

// JU-11: dev.120 read "Proof · No criteria recorded" with a deploy probe in Checks and nothing said in
// words; hop 0.2.0 listed design reviews among what users get
describe("a release says what it verified and keeps approved designs apart", () => {
  it("says the deploy check only, in words, where no criterion is recorded", () => {
    const r = { ...release, state: "shipped", verified: { level: "deploy_only", proven: 0, total: 0, check: "probed", provider: null } } as unknown as ReleaseDetail;
    renderWithQuery(<OverviewPane r={r} slug="forge" all={[]} />);
    const line = screen.getByTestId("release-verified");
    expect(line.getAttribute("data-level")).toBe("deploy_only");
    expect(line.textContent).toBe("Deploy check only: no criteria recorded");
  });

  it("counts proven criteria and names how the deploy was checked", () => {
    const r = { ...release, state: "shipped", verified: { level: "criteria", proven: 4, total: 4, check: "probed", provider: null } } as unknown as ReleaseDetail;
    renderWithQuery(<OverviewPane r={r} slug="forge" all={[]} />);
    expect(screen.getByTestId("release-verified").textContent).toBe("Verified: 4 criteria proven, and the deploy checked by the production probes");
  });

  it("lists a design-only issue under approved designs, outside what users get", () => {
    const design = { key: "ISS-18", title: "Referral screens design for the owner to approve", userFacing: "Referral design", technical: null };
    const r = { ...release, notes: { ...release.notes, attention: [], designs: [design] } } as unknown as ReleaseDetail;
    renderWithQuery(<OverviewPane r={r} slug="hop" all={[]} />);
    const designs = screen.getByTestId("release-designs-approved");
    expect(within(designs).getByText(design.title)).toBeTruthy();
    for (const section of screen.getAllByTestId("release-users-section")) {
      expect(within(section).queryByText(design.title)).toBeNull();
    }
  });
});
