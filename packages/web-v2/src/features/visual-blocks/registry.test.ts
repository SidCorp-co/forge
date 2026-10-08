// The parity between the contract's block kinds and the web renderers: a kind with no renderer, and a
// renderer with no kind, each fail by name. The planted cases prove the check can go red.

import { VISUAL_BLOCK_KINDS } from "@forge/contracts/visual-blocks";
import { describe, expect, it } from "vitest";
import { BLOCK_RENDERERS, currentParity, registryParity } from "./registry";

describe("block registry parity", () => {
  it("holds for the registry as it ships: every contract kind has a renderer", () => {
    expect(currentParity()).toEqual([]);
    for (const kind of VISUAL_BLOCK_KINDS) expect(BLOCK_RENDERERS[kind]).toBeTypeOf("function");
  });

  it("draws all six kinds the contract registers", () => {
    expect(Object.keys(BLOCK_RENDERERS).sort()).toEqual([...VISUAL_BLOCK_KINDS].sort());
  });

  it("goes red when a kind loses its renderer, naming it", () => {
    for (const kind of VISUAL_BLOCK_KINDS) {
      const drawn = VISUAL_BLOCK_KINDS.filter((k) => k !== kind);
      expect(registryParity(VISUAL_BLOCK_KINDS, drawn)).toEqual([`the contract kind "${kind}" has no renderer`]);
    }
  });

  it("goes red when the live registry is missing one, naming it", () => {
    const { chart: _gone, ...rest } = BLOCK_RENDERERS;
    expect(registryParity(VISUAL_BLOCK_KINDS, Object.keys(rest))).toEqual(['the contract kind "chart" has no renderer']);
  });

  it("refuses a renderer that has no contract kind, naming it", () => {
    expect(registryParity(["table"], ["table", "sparkline"])).toEqual(['the renderer "sparkline" has no contract kind']);
  });
});
