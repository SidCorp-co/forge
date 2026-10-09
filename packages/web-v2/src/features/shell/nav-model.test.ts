// ISS-1156 — the Attention badge states a figure only where both reads were read in full. A read on
// its way or failed is carried to every rail as a mark of its own, never as a count and never as no
// badge: a failure drawn as nothing owed is the silence this repairs.

import { describe, expect, it } from "vitest";
import { bottomTabItems, compactWorkspaceRailItems, OPEN_WORK_COUNTS, openWorkFigure, projectRailItems, workspaceNavItems } from "./nav-model";

const OPEN_WORK_29 = { badge: 29, badgeCounts: OPEN_WORK_COUNTS };

const rows = (b: Parameters<typeof workspaceNavItems>[0]) => {
  const found = [
    workspaceNavItems(b).find((i) => i.key === "overview"),
    compactWorkspaceRailItems(b).find((i) => i.key === "overview"),
    bottomTabItems(null, b, {}).find((i) => i.key === "attention"),
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

describe("the Issues badge", () => {
  it("is counted as open work on the rail and the bottom bar, and never as attention", () => {
    const rail = projectRailItems(OPEN_WORK_29).find((i) => i.key === "proj-issues");
    const bar = bottomTabItems("sable", { badge: 10, badgeCounts: "need attention" }, OPEN_WORK_29).find((i) => i.key === "proj-issues");
    for (const row of [rail, bar]) {
      expect(row?.badge).toBe(29);
      expect(row?.badgeCounts).toBe(OPEN_WORK_COUNTS);
      expect(row?.badgeCounts).toBe("in open work");
    }
  });

  it("gives no other project row a figure to name", () => {
    for (const row of projectRailItems(OPEN_WORK_29).filter((i) => i.key !== "proj-issues")) {
      expect(row.badge).toBeUndefined();
      expect(row.badgeCounts).toBeUndefined();
    }
  });

  it("carries a read on its way, and one that failed, to the rail and the bottom bar as a state of their own, never as a count or as nothing", () => {
    for (const [reads, state] of [[["pending", "read"], "pending"], [["read", "failed"], "failed"]] as const) {
      const figure = openWorkFigure([...reads], 0);
      const rail = projectRailItems(figure).find((i) => i.key === "proj-issues");
      const bar = bottomTabItems("sable", {}, figure).find((i) => i.key === "proj-issues");
      for (const row of [rail, bar]) {
        expect(row?.badgeRead).toBe(state);
        expect(row?.badge).toBeUndefined();
        expect(row?.badgeCounts).toBe(OPEN_WORK_COUNTS);
      }
    }
  });
});

describe("openWorkFigure", () => {
  it("states open work only where the projects list and the health read both came in, and names it as open work", () => {
    expect(openWorkFigure(["read", "read"], 29)).toEqual({ badge: 29, badgeCounts: "in open work" });
    expect(openWorkFigure(["read", "read"], 0)).toEqual({ badge: 0, badgeCounts: "in open work" });
  });

  it("says failed over a held count and pending before the read lands, never the attention words", () => {
    expect(openWorkFigure(["read", "failed"], 29)).toEqual({ badgeRead: "failed", badgeCounts: "in open work" });
    expect(openWorkFigure(["pending", "read"], 29)).toEqual({ badgeRead: "pending", badgeCounts: "in open work" });
  });
});
