// The parity between the contract's block kinds and the web renderers: a kind with no renderer, and a
// renderer with no kind, each fail by name. The planted cases prove the check can go red.

import { VISUAL_BLOCK_KINDS } from "@forge/contracts/visual-blocks";
import { describe, expect, it } from "vitest";
import { BLOCK_RENDERERS, currentParity, KINDS_NOT_DRAWN_YET, registryParity } from "./registry";

describe("block registry parity", () => {
  it("holds for the registry as it ships: every contract kind is drawn or named as not drawn yet", () => {
    expect(currentParity()).toEqual([]);
    for (const kind of VISUAL_BLOCK_KINDS) {
      expect([kind in BLOCK_RENDERERS, KINDS_NOT_DRAWN_YET.includes(kind)].filter(Boolean)).toHaveLength(1);
    }
  });

  it("draws table, kpi and status-list now, and leaves chart, timeline and flow to the next lane", () => {
    expect(Object.keys(BLOCK_RENDERERS).sort()).toEqual(["kpi", "status-list", "table"]);
    expect([...KINDS_NOT_DRAWN_YET].sort()).toEqual(["chart", "flow", "timeline"]);
  });

  it("refuses a contract kind that has no renderer, naming it", () => {
    expect(registryParity(["table", "gauge"], ["table"], [])).toEqual(['the contract kind "gauge" has no renderer']);
  });

  it("refuses a renderer that has no contract kind, naming it", () => {
    expect(registryParity(["table"], ["table", "sparkline"], [])).toEqual([
      'the renderer "sparkline" has no contract kind',
    ]);
  });

  it("refuses a kind that is both drawn and listed as not drawn yet", () => {
    expect(registryParity(["table"], ["table"], ["table"])).toEqual([
      'the kind "table" has a renderer and is also listed as not drawn yet',
    ]);
  });

  it("refuses a not-drawn-yet entry that is no contract kind", () => {
    expect(registryParity(["table"], ["table"], ["ghost"])).toEqual([
      '"ghost" is listed as not drawn yet but is no contract kind',
    ]);
  });
});
