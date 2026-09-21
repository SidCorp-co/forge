// ISS-1083 criteria 21–23 — what a settled turn above the newest one shows, and what it tucks away.
//
// The rule is here rather than in the renderer because it is a rule about ORDER: the machinery
// collapses to one row, and the prose it was interleaved with stays exactly where it was. A fold
// that reordered a turn's answer would be a worse defect than the wall of cards it replaces.

import { describe, expect, it } from "vitest";
import { foldTurn } from "./fold";
import type { RenderBlock } from "./types";

const text = (t: string): RenderBlock => ({ type: "text", text: t });
const tool = (id: string): RenderBlock => ({ type: "tool", tool: { id, name: "forge_issues" } });
const thinking = (): RenderBlock => ({ type: "thinking", count: 1 });
const todos = (): RenderBlock => ({
  type: "todos",
  todos: [{ content: "read the issue", status: "completed" }],
});

describe("what is left of a folded turn", () => {
  it("leaves the prose and puts one row where the machinery was", () => {
    const fold = foldTurn([text("Let me look."), tool("t1"), tool("t2"), text("Two are left.")]);
    expect(fold?.rows).toEqual([
      { kind: "block", block: text("Let me look."), index: 0 },
      { kind: "fold", label: "2 tool calls" },
      { kind: "block", block: text("Two are left."), index: 3 },
    ]);
  });

  it("collapses machinery that is spread through the turn into the one row", () => {
    const fold = foldTurn([
      tool("t1"),
      text("One is stale."),
      thinking(),
      tool("t2"),
      text("Two are left."),
    ]);
    expect(fold?.rows).toEqual([
      { kind: "fold", label: "2 tool calls and 1 pause" },
      { kind: "block", block: text("One is stale."), index: 1 },
      { kind: "block", block: text("Two are left."), index: 4 },
    ]);
  });

  it("names what it holds, and counts it in the plural it deserves", () => {
    expect(foldTurn([tool("t1")])?.rows[0]).toEqual({ kind: "fold", label: "1 tool call" });
    expect(foldTurn([tool("t1"), tool("t2"), tool("t3")])?.rows[0]).toEqual({
      kind: "fold",
      label: "3 tool calls",
    });
    expect(foldTurn([thinking()])?.rows[0]).toEqual({ kind: "fold", label: "1 pause" });
    expect(foldTurn([thinking(), thinking()])?.rows[0]).toEqual({ kind: "fold", label: "2 pauses" });
  });

  it("counts the pauses a block says it holds and not the blocks", () => {
    expect(foldTurn([{ type: "thinking", count: 3 }])?.rows[0]).toEqual({
      kind: "fold",
      label: "3 pauses",
    });
    expect(
      foldTurn([{ type: "thinking", count: 2 }, { type: "thinking" }])?.rows[0],
    ).toEqual({ kind: "fold", label: "3 pauses" });
  });

  it("leaves a task list standing", () => {
    const fold = foldTurn([todos(), tool("t1"), text("Done.")]);
    expect(fold?.rows).toEqual([
      { kind: "block", block: todos(), index: 0 },
      { kind: "fold", label: "1 tool call" },
      { kind: "block", block: text("Done."), index: 2 },
    ]);
  });
});

describe("the turns that have nothing to fold", () => {
  it("says so about a turn that is all prose", () => {
    expect(foldTurn([text("Two are left.")])).toBeNull();
    expect(foldTurn([text("One."), text("Two.")])).toBeNull();
    expect(foldTurn([])).toBeNull();
    expect(foldTurn([todos()])).toBeNull();
  });
});
