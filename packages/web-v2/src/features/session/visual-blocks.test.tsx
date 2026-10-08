// A turn's stored blocks reach the screen whole: a `visual` block is drawn through the block registry,
// and a block of a kind this screen does not know is named, not left out of the turn.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Conversation } from "./components/conversation";
import { type MessageEntry, parseMessages } from "./types";

afterEach(cleanup);

const table = {
  v: 1,
  kind: "table",
  columns: ["key"],
  source: { runId: "run-1" },
  frame: { fields: [{ name: "key", type: "ref", label: "Item" }], rows: [{ key: "ISS-5" }] },
};

const turn = (blocks: unknown[]): MessageEntry =>
  ({ id: "m1", type: "assistant", blocks }) as unknown as MessageEntry;

describe("a turn's blocks, parsed", () => {
  it("keeps a visual block in its place between the prose around it", () => {
    const [item] = parseMessages([
      turn([{ type: "text", text: "before" }, { type: "visual", visual: table }, { type: "text", text: "after" }]),
    ]);
    expect(item?.blocks.map((b) => b.type)).toEqual(["text", "visual", "text"]);
  });

  it("keeps a block of an unknown type, naming it", () => {
    const [item] = parseMessages([turn([{ type: "text", text: "hi" }, { type: "hologram", payload: 1 }])]);
    expect(item?.blocks[1]).toEqual({ type: "unsupported", name: "hologram" });
  });

  it("keeps the name core gave a block it could not read", () => {
    const [item] = parseMessages([turn([{ type: "unsupported", unsupported: "hologram" }])]);
    expect(item?.blocks).toEqual([{ type: "unsupported", name: "hologram" }]);
  });

  it("does not turn the blocks another module draws into unsupported rows", () => {
    const [item] = parseMessages([
      turn([{ type: "text", text: "hi" }, { type: "questionnaire", batchId: "b" }, { type: "designs", designs: { heading: "h", workflowIds: [] } }]),
    ]);
    expect(item?.blocks.map((b) => b.type)).toEqual(["text"]);
  });
});

describe("a turn's blocks, drawn", () => {
  it("draws a visual block as its table and an unknown block by name, both in the turn", () => {
    const items = parseMessages([
      turn([{ type: "visual", visual: table }, { type: "hologram" }, { type: "visual", visual: { v: 1, kind: "timeline" } }]),
    ]);
    render(<Conversation items={items} readOnly />);
    expect(screen.getByRole("table")).toBeTruthy();
    const named = screen.getAllByTestId("visual-block-unsupported").map((n) => n.textContent);
    expect(named).toEqual(["This answer has a hologram block this screen cannot show."]);
    expect(screen.getByTestId("visual-block-refused").textContent).toContain("This answer has a timeline block that does not match its shape");
  });
});
