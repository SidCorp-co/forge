// A criterion's evidence reads in a BA's terms first (what was judged, when, which work), with the
// issue key as a secondary link; the inline issue link leads with the title.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CriteriaTable } from "./requirement-proof";
import type { RequirementDetail } from "../types";

const d = {
  criteria: [{ code: "BC-1", form: "plain", sinceRevision: 1 }],
  standing: {
    shownRevision: 1,
    coverage: [
      {
        code: "BC-1",
        body: "Checkout totals include tax.",
        verdict: "passing",
        issues: [
          { issueId: "i1", displayId: "ISS-12", title: "Add tax to checkout", status: "closed", tone: "done", criterion: 2, verdict: "pass", verdictAt: "2026-10-05T09:30:00Z", stale: false },
        ],
      },
    ],
  },
} as unknown as RequirementDetail;

describe("a criterion's evidence", () => {
  it("says what passed and when, with the issue key secondary", async () => {
    render(<CriteriaTable d={d} slug="epod" />);
    await userEvent.click(screen.getByText(/What the evidence says/));
    const row = screen.getByTestId("criterion-evidence-row");
    expect(row).toHaveTextContent("Pass");
    expect(row).toHaveTextContent("Add tax to checkout");
    expect(row.querySelector("span[title]")).not.toBeNull();
    const key = within(row).getByRole("link", { name: "ISS-12" });
    expect(key).toHaveAttribute("href", "/projects/epod/issues/ISS-12");
    expect(key.className).toContain("text-subtle");
  });

  it("leads the inline link with the issue's title, not its key", () => {
    render(<CriteriaTable d={d} slug="epod" />);
    const row = screen.getByTestId("criterion-row");
    expect(within(row).getByRole("link", { name: "Add tax to checkout" })).toBeInTheDocument();
  });
});
