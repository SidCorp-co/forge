// A release's approver reads what it changes before its notes: per surface, risks first, design apart.

import type { ReleaseChanges } from "@forge/contracts/releases";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { changesSentence, WhatChanges } from "./release-changes";

const changes: ReleaseChanges = {
  surfaces: [
    {
      surface: "ui",
      count: 1,
      shipsNothing: false,
      issues: ["ISS-1"],
      artifacts: [{ ref: "screen:/cases", change: "added", issues: ["ISS-1"] }],
    },
    {
      surface: "data",
      count: 1,
      shipsNothing: false,
      issues: ["ISS-2"],
      artifacts: [{ ref: "table:hop_attention", change: "removed", issues: ["ISS-2"] }],
    },
    {
      surface: "design",
      count: 1,
      shipsNothing: true,
      issues: ["ISS-3"],
      artifacts: [{ ref: "discharge-post-care@rev7", change: "changed", issues: ["ISS-3"] }],
    },
  ],
  risks: [
    {
      risk: "data_removed",
      surface: "data",
      ref: "table:hop_attention",
      issues: ["ISS-2"],
      sentence: "table:hop_attention is removed: data it held does not come back with a rollback",
    },
  ],
  unclassified: [{ key: "ISS-4", why: "its landing is text that names no artifact", paths: [] }],
  shipsNothing: false,
};

describe("What changes", () => {
  it("names the deployed surfaces, flags the data removal, and keeps design apart as shipping nothing", () => {
    render(<WhatChanges changes={changes} slug="hop" />);
    expect(screen.getByTestId("release-changes-sentence").textContent).toBe(
      "Deploys UI and Data. 1 design revision ships nothing. 1 issue names nothing structured.",
    );
    const risk = screen.getByTestId("release-risk");
    expect(risk.getAttribute("data-risk")).toBe("data_removed");
    expect(risk.textContent).toContain("ISS-2");
    const deployed = screen.getByRole("list", { name: "Surfaces it deploys" });
    expect(within(deployed).getAllByTestId("release-surface").map((r) => r.getAttribute("data-surface"))).toEqual(["ui", "data"]);
    const apart = screen.getByTestId("release-ships-nothing");
    expect(within(apart).getByTestId("release-surface").getAttribute("data-surface")).toBe("design");
    expect(screen.getByTestId("release-unclassified").textContent).toContain("ISS-4");
  });

  it("opens a surface's artifacts with what became of each", () => {
    render(<WhatChanges changes={changes} slug="hop" />);
    const ui = screen.getAllByTestId("release-surface")[0] as HTMLElement;
    expect(within(ui).queryByTestId("release-artifact")).toBeNull();
    fireEvent.click(within(ui).getByTestId("release-surface-toggle"));
    const artifact = within(ui).getByTestId("release-artifact");
    expect(artifact.textContent).toContain("screen:/cases");
    expect(artifact.textContent).toContain("Added");
  });

  it("says a release of design revisions alone ships nothing", () => {
    const design = changes.surfaces[2];
    if (!design) throw new Error("fixture lost its design surface");
    expect(changesSentence({ surfaces: [design], risks: [], unclassified: [], shipsNothing: true })).toBe(
      "Ships nothing: every change in it is a design revision.",
    );
  });
});
