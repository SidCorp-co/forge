// The operator's reads of a release's notes, kept in the developer view when the reader's page took
// over "what users get": draft notes needing a rewrite, approved designs apart, and notes that call a
// production build a demo (HOP 0.5.0, 2026-10-08).

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import type { ReleaseDetail } from "../types";
import { ReleaseBanner } from "./release-bits";
import { ApprovedDesigns, DemoNotesWarning, NotesAttention } from "./release-note-reads";

const release = {
  key: "0.1.0",
  version: "0.1.0",
  state: "draft",
  production: null,
  notes: {
    sections: [],
    designs: [],
    withoutNotes: [],
    language: "vi",
    attention: [
      { key: "ISS-94", title: "Saved boards keep every card", notInLanguage: true, references: [] },
      { key: "ISS-98", title: "Export no longer fails", notInLanguage: true, references: ["commit sha 9db12a21a"] },
      { key: "ISS-99", title: "Rules", notInLanguage: false, references: ["code SOD-RULE-MAKER-CHECKER"] },
    ],
  },
} as unknown as ReleaseDetail;

describe("draft notes that need a rewrite", () => {
  it("says how many need attention, by cause, and links each", () => {
    renderWithQuery(<NotesAttention r={release} slug="hop" />);
    const line = screen.getByTestId("release-notes-attention");
    expect(line.textContent).toContain("3 notes need attention before release: 2 not in Vietnamese, 2 carry technical references");
    expect(within(line).getAllByRole("link").map((a) => a.textContent)).toEqual(["ISS-94", "ISS-98", "ISS-99"]);
  });

  it("shows no line when no note needs attention, or once the release is cut", () => {
    const { unmount } = renderWithQuery(<NotesAttention r={{ ...release, notes: { ...release.notes, attention: [] } } as ReleaseDetail} slug="hop" />);
    expect(screen.queryByTestId("release-notes-attention")).toBeNull();
    unmount();
    renderWithQuery(<NotesAttention r={{ ...release, state: "shipped" } as ReleaseDetail} slug="hop" />);
    expect(screen.queryByTestId("release-notes-attention")).toBeNull();
  });
});

describe("approved designs are kept apart from what users get", () => {
  it("lists a design-only issue under approved designs", () => {
    const design = { key: "ISS-18", title: "Referral screens design for the owner to approve", userFacing: "Referral design", technical: null };
    renderWithQuery(<ApprovedDesigns r={{ ...release, notes: { ...release.notes, designs: [design] } } as unknown as ReleaseDetail} slug="hop" />);
    expect(within(screen.getByTestId("release-designs-approved")).getByText(design.title)).toBeTruthy();
  });
});

const r050 = {
  version: "0.5.0",
  state: "shipped",
  current: true,
  attentionGroup: "done",
  waitingOn: { kind: "none", who: "", act: "", rule: "r", ref: null, dueAt: null },
  production: { name: "production", url: "https://hop.auto.sidcorp.co" },
  notes: {
    sections: [
      {
        section: "Added",
        entries: [
          { key: "ISS-122", title: "Publish the reports (ISS-102) to the dev site", userFacing: "The demo site now has the CRM report screen at /pages/reports.", technical: null },
          { key: "ISS-83", title: "Patient 360 screen", userFacing: "Staff open a patient's 360 record from the menu.", technical: null },
        ],
      },
    ],
    designs: [],
    withoutNotes: [],
    language: "en",
    attention: [],
  },
};

describe("a production release whose notes call it a demo", () => {
  it("says which notes call the build a demo while the release went to production", () => {
    renderWithQuery(<DemoNotesWarning r={r050 as never} />);
    expect(screen.getByTestId("release-customer-demo")).toHaveTextContent("ISS-122");
    expect(screen.getByTestId("release-customer-demo")).toHaveTextContent("hop.auto.sidcorp.co");
  });

  it("names the site a live release serves, beside the word production", () => {
    renderWithQuery(<ReleaseBanner r={r050 as never} />);
    expect(screen.getByText(/Live on production at hop\.auto\.sidcorp\.co\./)).toBeInTheDocument();
  });
});
