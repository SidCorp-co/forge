// ISS-962: a gate issue outside a release's roster that its range could not be placed against is
// named in the Technical view, with why, never assumed absent.
// @direct-test-of packages/web-v2/src/features/releases/components/release-technical.tsx

import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReleasePage } from "@forge/contracts/release-page";
import { releasePage, TECHNICAL } from "@/test/release-page";
import { renderWithQuery } from "@/test/render";
import { Technical } from "./release-technical";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const read = (unchecked: Extract<ReleasePage["shipped"], { state: "read" }>["unchecked"]) => {
  const shipped = releasePage().shipped;
  if (shipped.state !== "read") throw new Error("the fixture reads its range");
  return { ...shipped, unchecked };
};

describe("the gate issues outside the roster the range could not place (ISS-962)", () => {
  it("names each with why", () => {
    const shipped = read([{ issueKey: "ISS-144", commit: null, why: "its merge names no commit" }]);
    renderWithQuery(<Technical page={releasePage({ view: "developer", technical: TECHNICAL, shipped })} slug="forge" />);
    const unchecked = screen.getByTestId("page-technical-unchecked");
    expect(unchecked).toHaveTextContent("Not checked");
    expect(unchecked).toHaveTextContent("ISS-144: its merge names no commit");
  });

  it("draws nothing where none went unplaced, or where the reading predates the check", () => {
    for (const unchecked of [[], null]) {
      const { unmount } = renderWithQuery(
        <Technical page={releasePage({ view: "developer", technical: TECHNICAL, shipped: read(unchecked) })} slug="forge" />,
      );
      expect(screen.queryByTestId("page-technical-unchecked")).toBeNull();
      unmount();
    }
  });
});
