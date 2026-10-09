// ISS-460 (REQ-35): a person draws a requirement's wireframe on the Excalidraw board, and the board is
// read back as the wireframe-v1 document the picture stores. Boxes keep the shape `toScene` drew them
// as, words drawn inside a box are its label, a board drawn left of or above the canvas moves whole
// onto it, and an element no wireframe holds is refused by its type, never guessed into a shape.

import { describe, expect, it } from "vitest";
import { type SceneElement, sceneToWireframe } from "./scene-to-wireframe";

const box = (id: string, over: Partial<SceneElement> = {}): SceneElement => ({ id, type: "rectangle", x: 10, y: 20, width: 120, height: 40, ...over });
const words = (id: string, containerId: string | null, text: string, over: Partial<SceneElement> = {}): SceneElement => ({
  id,
  type: "text",
  x: 12,
  y: 22,
  width: 80,
  height: 20,
  containerId,
  text,
  originalText: text,
  ...over,
});

describe("reading the board back as a wireframe", () => {
  it("keeps each box's shape and label, free text, a bound arrow and a pen stroke", () => {
    const read = sceneToWireframe(
      [
        box("pay", { customData: { wf: "button", label: "Pay" } }),
        words("pay-t", "pay", "Pay now"),
        box("card", { y: 100, customData: { wf: "input", placeholder: "Card number" } }),
        words("card-t", "card", "Card number"),
        box("lines", { y: 200, height: 90, customData: { wf: "list", label: "Basket", items: [] } }),
        words("lines-t", "lines", "Basket\nTea\nCake"),
        box("page", { width: 400, height: 400 }),
        words("note", null, "Total"),
        { id: "go", type: "arrow", x: 70, y: 60, width: 0, height: 40, points: [[0, 0], [0, 40]], startBinding: { elementId: "pay" }, endBinding: { elementId: "card" } },
        { id: "ink", type: "freedraw", x: 300, y: 300, width: 10, height: 10, points: [[0, 0], [10, 10]] },
        box("gone", { isDeleted: true }),
      ],
      "Checkout",
    );
    expect(read).toEqual({
      ok: true,
      doc: {
        v: "wireframe-v1",
        title: "Checkout",
        shapes: [
          { type: "button", id: "pay", x: 10, y: 20, w: 120, h: 40, label: "Pay now" },
          { type: "input", id: "card", x: 10, y: 100, w: 120, h: 40, placeholder: "Card number" },
          { type: "list", id: "lines", x: 10, y: 200, w: 120, h: 90, label: "Basket", items: ["Tea", "Cake"] },
          { type: "frame", id: "page", x: 10, y: 20, w: 400, h: 400 },
          { type: "text", id: "note", x: 12, y: 22, w: 80, h: 20, text: "Total" },
          { type: "arrow", id: "go", from: { id: "pay" }, to: { id: "card" } },
          { type: "pen", id: "ink", points: [[300, 300], [310, 310]] },
        ],
      },
    });
  });

  it("moves a board drawn above and left of the canvas onto it whole", () => {
    const read = sceneToWireframe([box("a", { x: -50, y: -10 }), box("b", { x: 100, y: 30 })]);
    expect(read.ok && read.doc.shapes.map((s) => ("x" in s ? [s.x, s.y] : null))).toEqual([
      [0, 0],
      [150, 40],
    ]);
  });

  it("refuses an element no wireframe holds by its type", () => {
    expect(sceneToWireframe([box("a"), { id: "o", type: "ellipse", x: 0, y: 0, width: 10, height: 10 }])).toEqual({ ok: false, unsupported: "ellipse" });
  });

  it("refuses a board the wireframe parser refuses, in the parser's words", () => {
    const read = sceneToWireframe([box("huge", { width: 5000 })]);
    expect(read.ok).toBe(false);
    expect(!read.ok && "invalid" in read && read.invalid).toMatch(/^WIREFRAME_OUT_OF_BOUNDS: shapes\.0\.w/);
  });
});
