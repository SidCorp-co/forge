// ISS-1156 — the Attention badge states a figure only where both reads were read in full. A read on
// its way or failed is carried to every rail as a mark of its own, never as a count and never as no
// badge: a failure drawn as nothing owed is the silence this repairs.

import { describe, expect, it } from "vitest";
import { bottomTabItems, compactWorkspaceRailItems, workspaceNavItems } from "./nav-model";

const rows = (b: Parameters<typeof workspaceNavItems>[0]) => {
  const found = [
    workspaceNavItems(b).find((i) => i.key === "overview"),
    compactWorkspaceRailItems(b).find((i) => i.key === "overview"),
    bottomTabItems(null, b, undefined).find((i) => i.key === "attention"),
  ];
  return found.map((row) => {
    if (!row) throw new Error("a row the nav model must carry is missing");
    return row;
  });
};

describe("the Attention badge", () => {
  it("carries a read count to the rail rows and the bottom bar", () => {
    for (const row of rows({ badge: 4 })) {
      expect(row.badge).toBe(4);
      expect(row.badgeRead).toBeUndefined();
    }
  });

  it("carries a read on its way, and one that failed, as a state of their own on every one of them", () => {
    for (const row of rows({ badgeRead: "pending" })) {
      expect(row.badgeRead).toBe("pending");
      expect(row.badge).toBeUndefined();
    }
    for (const row of rows({ badgeRead: "failed" })) {
      expect(row.badgeRead).toBe("failed");
      expect(row.badge).toBeUndefined();
    }
  });
});
