// A release's approver reads what it changes before its notes: per surface, risks first, design apart.

import { say } from "@/test/said";
import type { ReleaseChanges } from "@forge/contracts/releases";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { labelCopy } from "@/lib/i18n/labels";
import { productCopy } from "@/lib/i18n/product-copy";
import { changesSentence, WhatChanges } from "./release-changes";

const changes: ReleaseChanges = {
  surfaces: [
    {
      surface: "ui",
      count: 1,
      shipsNothing: false,
      issues: ["ISS-1"],
      artifacts: [{ ref: "screen:/cases", change: "added", issues: ["ISS-1"], carriedBy: null }],
    },
    {
      surface: "data",
      count: 1,
      shipsNothing: false,
      issues: ["ISS-2"],
      artifacts: [{ ref: "table:hop_attention", change: "removed", issues: ["ISS-2"], carriedBy: null }],
    },
    {
      surface: "design",
      count: 1,
      shipsNothing: true,
      issues: ["ISS-3"],
      artifacts: [{ ref: "discharge-post-care@rev7", change: "changed", issues: ["ISS-3"], carriedBy: null }],
    },
  ],
  risks: [
    {
      risk: "data_removed",
      surface: "data",
      ref: "table:hop_attention",
      issues: ["ISS-2"],
      sentence: "table:hop_attention is removed: a rollback does not restore its data",
      says: { sentence: say("standing.risk.dataRemoved", { ref: "table:hop_attention" }) },
    },
  ],
  unclassified: [{ key: "ISS-4", why: "its landing is text that names no artifact", paths: [] }],
  boxRead: ["ISS-1"],
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
    fireEvent.click(screen.getByTestId("release-unclassified-toggle"));
    expect(screen.getByTestId("release-unclassified").textContent).toContain("ISS-4");
    expect(screen.getByTestId("release-box-read").textContent).toContain("ISS-1");
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

  it("says an artifact another issue's release ships is carried by it, in both languages", () => {
    const carried: ReleaseChanges = {
      ...changes,
      surfaces: [
        {
          surface: "logic",
          count: 1,
          shipsNothing: false,
          issues: ["ISS-54"],
          artifacts: [
            { ref: "workflow 193 @999dcf6d: access block", change: "changed", issues: ["ISS-54"], carriedBy: "ISS-110" },
          ],
        },
      ],
    };
    render(<WhatChanges changes={carried} slug="hop" />);
    fireEvent.click(screen.getByTestId("release-surface-toggle"));
    expect(screen.getByTestId("release-artifact-carried").textContent).toBe("carried by ISS-110");
    expect(productCopy("vi")("releases.changes.carriedBy", { issue: "ISS-110" })).toBe("phát hành cùng ISS-110"); // i18n-allow: asserts the vi carriage copy
  });

  it("counts paths a release's range changed that no surface claims as paths, under no issue", () => {
    const range: ReleaseChanges = {
      surfaces: [],
      risks: [],
      unclassified: [{ key: null, why: "no rule of `surfaces` claims these paths the range changes", paths: ["biome.json", "packages/core/tsconfig.json"] }],
      boxRead: [],
      shipsNothing: false,
    };
    expect(changesSentence(range, productCopy("en"), labelCopy("en"))).toBe("2 paths no surface claims.");
    render(<WhatChanges changes={range} slug="hop" />);
    expect(screen.getByTestId("release-unclassified-toggle").textContent).toBe("2 artifacts");
    fireEvent.click(screen.getByTestId("release-unclassified-toggle"));
    expect(screen.getByTestId("release-unclassified").textContent).toContain("biome.json");
  });

  it("says a range kept without its files was not read, with its reason and nothing to open", () => {
    const kept: ReleaseChanges = {
      surfaces: [],
      risks: [],
      unclassified: [{ key: null, why: "the range was kept before its changed files were: report it again to list them", paths: [] }],
      boxRead: [],
      shipsNothing: false,
    };
    expect(changesSentence(kept, productCopy("en"), labelCopy("en"))).toBe("Not read.");
    render(<WhatChanges changes={kept} slug="hop" />);
    expect(screen.queryByTestId("release-unclassified-toggle")).toBeNull();
    expect(screen.getByTestId("release-unclassified").textContent).toContain("report it again");
  });

  it("says a release of design revisions alone ships nothing", () => {
    const design = changes.surfaces[2];
    if (!design) throw new Error("fixture lost its design surface");
    expect(changesSentence({ surfaces: [design], risks: [], unclassified: [], boxRead: [], shipsNothing: true }, productCopy("en"), labelCopy("en"))).toBe(
      "Ships nothing: every change in it is a design revision.",
    );
  });
});
