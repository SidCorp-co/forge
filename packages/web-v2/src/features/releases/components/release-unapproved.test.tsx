// A release that went ahead where a person's approval was only advised says so above its page
// (REQ-79 r6): outside strict an agent ships it, and nobody reading it mistakes it for approved.

import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { releasePage } from "@/test/release-page";
import { renderWithQuery } from "@/test/render";
import { ReleaseReader } from "./release-reader";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const withApproval = (state: "unapproved" | "approved" | "not_asked") =>
  releasePage({
    header: {
      ...releasePage().header,
      approval: { required: false, state, by: null, at: state === "unapproved" ? "2026-10-31T10:00:00.000Z" : null },
    },
  });

describe("a release no person approved, where approval was advised", () => {
  it("says it was not approved by a person, to a reader who is not signed in", () => {
    renderWithQuery(<ReleaseReader page={withApproval("unapproved")} authed={false} />);
    expect(screen.getByTestId("release-unapproved").textContent).toContain("Not approved by a person");
  });

  it("says nothing where it was approved, or where nobody was asked", () => {
    renderWithQuery(<ReleaseReader page={withApproval("not_asked")} authed={false} />);
    expect(screen.queryByTestId("release-unapproved")).toBeNull();
  });
});
