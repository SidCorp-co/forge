import { describe, expect, it } from "vitest";
import { costParts, costSummary } from "./wait-cost";

describe("what a wait costs", () => {
  it("reads in the order the server ranked by", () => {
    expect(
      costSummary({ cost: { claimsHeld: 2, workspacesPinned: 1, dependents: 3 } }),
      "claims first, because a held claim denies a runner slot to every other issue — the same order `AWAITING_COST_ORDER` uses",
    ).toBe("2 claims · 1 workspace · 3 dependents");
  });

  it("drops the parts that cost nothing", () => {
    expect(costSummary({ cost: { claimsHeld: 0, workspacesPinned: 0, dependents: 4 } })).toBe(
      "4 dependents",
    );
  });

  // cm:guard absent is not zero: core sets `cost` on the awaiting bucket alone, so a row from any other bucket must render nothing rather than "0 claims" (ISS-964 criterion 53).
  it("says nothing at all for a row that carries no cost", () => {
    expect(costSummary({})).toBeNull();
    expect(costSummary({ cost: { claimsHeld: 0, workspacesPinned: 0, dependents: 0 } })).toBeNull();
    expect(costParts({})).toEqual([]);
  });

  it("uses the singular for exactly one", () => {
    expect(costSummary({ cost: { claimsHeld: 1, workspacesPinned: 1, dependents: 1 } })).toBe(
      "1 claim · 1 workspace · 1 dependent",
    );
  });
});
