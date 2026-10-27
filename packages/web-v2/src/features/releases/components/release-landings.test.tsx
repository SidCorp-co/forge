// A landing recorded before a recorded landing took a version (core `release-batch/landing-records.ts`):
// the Releases list names the branch and commit, says no environment and no version, so a landing is
// never read as a deploy nor given a number it was not recorded under.

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import { ReleaseLandings } from "./release-landings";

describe("the landings on the Releases list", () => {
  it("reads each as landed on its branch at its commit, with no environment and no version", () => {
    renderWithQuery(
      <ReleaseLandings
        landings={[{ runId: "r1", branch: "release/stg", commit: "f4e5fb66700ba7b35c8c607c8f7309fc5980861a", at: "2026-10-22T11:00:00.000Z", issues: ["ISS-5"], closedAll: true }]}
      />,
    );
    expect(screen.getByRole("region", { name: "Recorded before versioning" })).toBeTruthy();
    const row = screen.getByTestId("release-landing");
    expect(row.textContent).toContain("Landed on release/stg at f4e5fb6 — no environment, no version");
    expect(row.textContent).toContain("ISS-5");
    expect(row.textContent).not.toMatch(/deploy|production|serving|did not close/i);
  });

  it("says so where some issue it named did not close", () => {
    renderWithQuery(
      <ReleaseLandings
        landings={[{ runId: "r2", branch: "dev", commit: "f44ff116700ba7b35c8c607c8f7309fc5980861a", at: "2026-10-26T04:57:01.000Z", issues: ["ISS-9"], closedAll: false }]}
      />,
    );
    expect(screen.getByTestId("release-landing").textContent).toContain("Some issues did not close");
  });

  it("shows nothing where no landing is recorded", () => {
    renderWithQuery(<ReleaseLandings landings={[]} />);
    expect(screen.queryByTestId("release-landings")).toBeNull();
  });
});
