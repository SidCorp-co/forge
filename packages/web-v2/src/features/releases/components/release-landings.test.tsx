// A project with no production environment records each landing as its release
// (core `release-batch/recorded-landing.ts`): the Releases list names the branch and commit, and
// says no environment, so a landing is never read as a deploy.

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import { ReleaseLandings } from "./release-landings";

describe("the landings on the Releases list", () => {
  it("reads each as landed on its branch at its commit, with no environment", () => {
    renderWithQuery(
      <ReleaseLandings
        landings={[{ runId: "r1", branch: "release/stg", commit: "f4e5fb66700ba7b35c8c607c8f7309fc5980861a", at: "2026-10-22T11:00:00.000Z", issues: ["ISS-5"] }]}
      />,
    );
    const row = screen.getByTestId("release-landing");
    expect(row.textContent).toContain("Landed on release/stg at f4e5fb6 — no environment");
    expect(row.textContent).toContain("ISS-5");
    expect(row.textContent).not.toMatch(/deploy|production|serving/i);
  });

  it("shows nothing where no landing is recorded", () => {
    renderWithQuery(<ReleaseLandings landings={[]} />);
    expect(screen.queryByTestId("release-landings")).toBeNull();
  });
});
