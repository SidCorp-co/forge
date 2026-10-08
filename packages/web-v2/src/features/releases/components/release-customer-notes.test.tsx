// The HOP journey walk (2026-10-08): 0.5.0's notes could not be handed to a customer, and the page
// said "Live on production" over notes that call the build a dev demo. The Notes tab opens with the
// customer's view, copied or exported as it reads, and says where the notes and the label disagree.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { ReleaseBanner } from "./release-bits";
import { CustomerNotes } from "./release-customer-notes";

const entry = (key: string, title: string, userFacing: string) => ({ key, title, userFacing, technical: null });

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
          entry("ISS-102", "Demo CRM report screen", "CRM reports and campaign ROI, each with its definition."),
          entry("ISS-122", "Publish the reports (ISS-102) to the dev site", "The demo site now has the CRM report screen at /pages/reports."),
          entry("ISS-83", "Patient 360 screen", "Staff open a patient's 360 record (/pages/patients?key=<HOP key>) from the menu."),
        ],
      },
    ],
    designs: [],
    withoutNotes: [],
    language: "en",
    attention: [],
  },
};

describe("the customer's view of a release's notes", () => {
  it("lists each change once, with no issue key, internal title or path", () => {
    renderWithQuery(<CustomerNotes r={r050 as never} />);
    const view = screen.getByTestId("release-customer-view");
    const lines = within(view).getAllByTestId("release-customer-line").map((l) => l.textContent);
    expect(lines).toEqual(["CRM reports and campaign ROI, each with its definition.", "Staff open a patient's 360 record from the menu."]);
    expect(view).not.toHaveTextContent("ISS-");
    expect(view).not.toHaveTextContent("Publish the reports");
  });

  it("copies the view as text", async () => {
    const writeText = vi.fn(async () => undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderWithQuery(<CustomerNotes r={r050 as never} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "# 0.5.0\n\n## Added\n- CRM reports and campaign ROI, each with its definition.\n- Staff open a patient's 360 record from the menu.\n",
      ),
    );
  });

  it("exports the view as a Markdown file named for the release", async () => {
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      created.push(b);
      return "blob:notes";
    });
    URL.revokeObjectURL = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<CustomerNotes r={r050 as never} />);
    const link = screen.getByRole("button", { name: "Export" });
    await user.click(link);
    expect(created).toHaveLength(1);
    expect(await created[0]?.text()).toContain("# 0.5.0");
  });

  it("says which notes call the build a demo while the release went to production", () => {
    renderWithQuery(<CustomerNotes r={r050 as never} />);
    expect(screen.getByTestId("release-customer-demo")).toHaveTextContent("ISS-122");
    expect(screen.getByTestId("release-customer-demo")).toHaveTextContent("hop.auto.sidcorp.co");
  });

  it("names the site a live release serves, beside the word production", () => {
    renderWithQuery(<ReleaseBanner r={r050 as never} />);
    expect(screen.getByText(/Live on production at hop\.auto\.sidcorp\.co\./)).toBeInTheDocument();
  });
});
