import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import { AT, STATUS } from "../status-fixture";
import { ShippedRecently } from "./shipped-recently";

// JU-3: after hop 0.2.0 shipped 50 issues the dashboard still led with "Next release 0.3.0"; it now
// leads with what last reached people, and says so plainly when nothing ever has.

const clock = { lang: "en" as const, now: Date.parse(AT), timeZone: "UTC" };

describe("Shipped recently on the dashboard", () => {
  it("names the last release shipped, when, how many issues and what was verified", () => {
    renderWithQuery(<ShippedRecently shipped={STATUS.shipped} slug="hop" clock={clock} />);
    const line = screen.getByTestId("shipped-recently-last");
    expect(line.textContent).toContain("0.2.0");
    expect(line.textContent).toContain("06/10/2026");
    expect(line.textContent).toContain("2 issues");
    expect(line.textContent).toContain("Partly verified: 1 of 2 criteria proven");
    expect(line.textContent).toContain("completes REQ-3");
    expect(screen.getByTestId("shipped-recently-report").getAttribute("href")).toBe("/projects/hop/status");
  });

  it("says no release has reached users when none ever shipped", () => {
    renderWithQuery(<ShippedRecently shipped={{ ...STATUS.shipped, latest: null, releases: [], releaseCount: 0 }} slug="hop" clock={clock} />);
    expect(screen.getByTestId("shipped-recently-none").textContent).toBe("No release has reached users yet.");
  });
});
