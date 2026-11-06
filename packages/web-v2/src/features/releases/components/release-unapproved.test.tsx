// A release that went ahead with no person approving, on a project that requires an approval, says so
// under Needs attention (REQ-79 r6, ISS-1001); where none is required core reads it not asked
// (`release-page/sections.ts:approvalOf`, ISS-1071), so the page has nothing to flag.

import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { releasePage } from "@/test/release-page";
import { renderWithQuery } from "@/test/render";
import { ReleaseReport } from "./release-report";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const withApproval = (state: "unapproved" | "approved" | "not_asked") =>
  releasePage({
    header: {
      ...releasePage().header,
      approval: { required: state === "unapproved", state, by: null, at: state === "unapproved" ? "2026-10-31T10:00:00.000Z" : null },
    },
  });

describe("a release no person approved, where approval is required", () => {
  it("says it was not approved by a person, to a reader who is not signed in", () => {
    renderWithQuery(<ReleaseReport page={withApproval("unapproved")} />);
    const item = screen.getAllByTestId("page-attention-item").find((i) => i.dataset.kind === "unapproved");
    expect(item?.textContent).toBe("Not approved by a person");
  });

  it("says nothing where it was approved, or where nobody was asked", () => {
    for (const state of ["approved", "not_asked"] as const) {
      const { unmount } = renderWithQuery(<ReleaseReport page={withApproval(state)} />);
      expect(screen.queryAllByTestId("page-attention-item").filter((i) => i.dataset.kind === "unapproved")).toEqual([]);
      unmount();
    }
  });
});
