// A criterion's evidence reads in a BA's terms first (what was judged, when, which work), with the
// issue key as a secondary link; the inline issue link leads with the title.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CriteriaChecklist } from "./requirement-proof";
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
    render(<CriteriaChecklist d={d} slug="epod" />);
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
    render(<CriteriaChecklist d={d} slug="epod" />);
    const row = screen.getByTestId("criterion-row");
    expect(within(row).getByRole("link", { name: "Add tax to checkout" })).toBeInTheDocument();
  });

  // coverage-truth: REQ-32 read 1 of 16 passing while 7 held live, and nothing on the page said which
  // verdict a BC's standing came from; each BC now names the newest verdict, the one that counts
  it("names the verdict that counts, with its issue, criterion and commit, and marks one the live build lacks", async () => {
    const OLD = "e523c4b0ff9038187ad0e7d81f69a3e087c8c252";
    const NEW = "0fecd0850aa11bb22cc33dd44ee55ff6677889900";
    const two = {
      criteria: [{ code: "BC-1", form: "plain", sinceRevision: 1 }],
      standing: {
        shownRevision: 1,
        coverage: [
          {
            code: "BC-1",
            body: "Checkout totals include tax.",
            verdict: "passing",
            counts: { issueId: "i2", displayId: "ISS-31", criterion: 4, verdict: "short", at: "2026-10-08T16:17:36Z", commit: NEW, inLiveBuild: true },
            issues: [
              { issueId: "i1", displayId: "ISS-12", title: "Add tax", status: "closed", tone: "done", criterion: 2, verdict: "fail", verdictAt: "2026-10-01T09:30:00Z", commit: OLD, inLiveBuild: false, stale: false },
              { issueId: "i2", displayId: "ISS-31", title: "Fix tax", status: "closed", tone: "done", criterion: 4, verdict: "short", verdictAt: "2026-10-08T16:17:36Z", commit: NEW, inLiveBuild: true, stale: false },
            ],
          },
        ],
      },
    } as unknown as RequirementDetail;
    render(<CriteriaChecklist d={two} slug="epod" />);
    const counts = screen.getByTestId("criterion-counts");
    expect(counts).toHaveTextContent("Counts: Short on ISS-31 criterion 4, the newest verdict");
    expect(counts).toHaveTextContent("0fecd0850");
    await userEvent.click(screen.getByText(/What the evidence says/));
    const [old, fresh] = screen.getAllByTestId("criterion-evidence-row");
    expect(old).toHaveTextContent("e523c4b0f");
    expect(old).toHaveTextContent("judged at a commit the live build does not hold, so it does not count");
    expect(fresh).not.toHaveTextContent("does not hold");
  });

  it("names no counting verdict where none is judged", () => {
    render(<CriteriaChecklist d={d} slug="epod" />);
    expect(screen.queryByTestId("criterion-counts")).toBeNull();
  });

  it("names why the accepted breakdown left a gap without an issue (R-6)", () => {
    const gap = {
      criteria: [{ code: "BC-2", form: "plain", sinceRevision: 1 }],
      standing: {
        shownRevision: 1,
        facts: { issuesTotal: 1 },
        coverage: [
          { code: "BC-2", body: "Refunds post the same day.", verdict: "gap", issues: [], uncoveredReason: "the bank's batch decides this" },
        ],
      },
    } as unknown as RequirementDetail;
    render(<CriteriaChecklist d={gap} slug="epod" />);
    expect(screen.getByTestId("criterion-uncovered")).toHaveTextContent(
      "Left without an issue by the accepted breakdown: the bank's batch decides this",
    );
  });
});
