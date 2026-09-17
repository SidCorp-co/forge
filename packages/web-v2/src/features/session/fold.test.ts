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

  // cm:guard ONE row for the whole turn, at the position of the FIRST thing it collapsed — and the
  // prose keeps its order around it. A turn that called a tool, wrote, called another and wrote
  // again is the common shape of a real answer, and a fold that emitted a row per run would put
  // three rows in a turn criterion 22 says collapses to one.
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

  // cm:guard a pause's own `count` is the number of pauses, and one block can carry several: the
  // Claude Code derive folds a turn's pauses into a single block holding `thinkingCount`, and
  // `ThinkingLine` reads that block back as "Thought 3 times". Counting blocks made the fold row say
  // "1 pause" directly above a line saying it thought three times.
  it("counts the pauses a block says it holds and not the blocks", () => {
    expect(foldTurn([{ type: "thinking", count: 3 }])?.rows[0]).toEqual({
      kind: "fold",
      label: "3 pauses",
    });
    expect(
      foldTurn([{ type: "thinking", count: 2 }, { type: "thinking" }])?.rows[0],
    ).toEqual({ kind: "fold", label: "3 pauses" });
  });

  // cm:guard a task list is NOT machinery: it is what the agent said it would do, which a reader
  // scanning an old turn reads for the same reason they read its prose. Criterion 22 names thinking
  // lines and tool cards, and widening it here would hide the one block that says what a turn was
  // for.
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
  // cm:guard `null` and not an empty fold: it is what tells the renderer to draw the turn exactly as
  // it always was, so a turn whose whole answer is prose is untouched by any of this.
  it("says so about a turn that is all prose", () => {
    expect(foldTurn([text("Two are left.")])).toBeNull();
    expect(foldTurn([text("One."), text("Two.")])).toBeNull();
    expect(foldTurn([])).toBeNull();
    expect(foldTurn([todos()])).toBeNull();
  });
});
