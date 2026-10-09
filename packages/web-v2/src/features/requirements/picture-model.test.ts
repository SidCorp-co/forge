// ISS-460 (REQ-35): what the picture's editor turns typed lines into, and where a refusal's path lands.

import { describe, expect, it } from "vitest";
import { chartDraftOf, chartFromDraft, fieldOfPath, flowFromLines, flowToLines, presentTrace } from "./picture-model";

describe("a flow typed as lines", () => {
  it("takes one step per line and links between them, naming a step in any case, each step an id of its own", () => {
    const read = flowFromLines("Pay now\nPay: now\n\n  Ship  ", "pay now -> Pay: now\nPAY NOW -> Ship: then", "Checkout");
    expect(read).toEqual({
      ok: true,
      content: {
        title: "Checkout",
        nodes: [
          { id: "pay-now", label: "Pay now" },
          { id: "pay-now-2", label: "Pay: now" },
          { id: "ship", label: "Ship" },
        ],
        edges: [
          { from: "pay-now", to: "pay-now-2" },
          { from: "pay-now", to: "ship", label: "then" },
        ],
      },
    });
  });

  it("names what it cannot read by its line: no step, a line that is no link, a step that is not there", () => {
    expect(flowFromLines(" \n", "")).toEqual({ ok: false, fault: { field: "steps", fault: "none" } });
    expect(flowFromLines("Pay\n\npay", "")).toEqual({ ok: false, fault: { field: "steps", fault: "repeated", line: 3, name: "pay" } });
    expect(flowFromLines("A", "\nA to B")).toEqual({ ok: false, fault: { field: "links", fault: "notLink", line: 2 } });
    expect(flowFromLines("A", "A -> B")).toEqual({ ok: false, fault: { field: "links", fault: "unknownStep", line: 1, name: "B" } });
  });

  it("opens a stored flow as the lines it was typed as", () => {
    expect(flowToLines({ nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b", label: "go" }] })).toEqual({ steps: "A\nB", links: "A -> B: go" });
  });
});

describe("a sample chart typed as labelled figures", () => {
  const draft = { variant: "line" as const, xLabel: "Week", valueLabel: "Orders", rows: [{ label: "W1", value: "3" }, { label: "", value: "" }] };

  it("draws one series of sample figures, a blank row left out", () => {
    const read = chartFromDraft(draft);
    expect(read.ok && read.content.frame.rows).toEqual([{ label: "W1", value: 3 }]);
    expect(read.ok && chartDraftOf(read.content)).toEqual({ ...draft, rows: [{ label: "W1", value: "3" }] });
  });

  it("names an unnamed axis, no figures, and a figure that is not a number", () => {
    expect(chartFromDraft({ ...draft, xLabel: " " })).toEqual({ ok: false, fault: { field: "xLabel" } });
    expect(chartFromDraft({ ...draft, valueLabel: "" })).toEqual({ ok: false, fault: { field: "valueLabel" } });
    expect(chartFromDraft({ ...draft, rows: [] })).toEqual({ ok: false, fault: { field: "rows" } });
    expect(chartFromDraft({ ...draft, rows: [{ label: "W1", value: "3" }, { label: "W2", value: "many" }] })).toEqual({ ok: false, fault: { field: "row", row: 2 } });
  });
});

describe("where a refusal lands in the editor", () => {
  it("puts each path on the field it names, and one naming none on the editor", () => {
    expect(fieldOfPath("/alt", "flow")).toBe("alt");
    expect(fieldOfPath("/kind", "chart")).toBe("kind");
    expect(fieldOfPath("/content/rows/3", "example_table")).toBe("row:3");
    expect(fieldOfPath("/content/nodes/0/label", "flow")).toBe("steps");
    expect(fieldOfPath("/content/edges/1/to", "flow")).toBe("links");
    expect(fieldOfPath("/content/board", "wireframe")).toBe("board");
    expect(fieldOfPath("/content/frame/rows/0", "chart")).toBe("content");
    expect(fieldOfPath("/revision", "chart")).toBeNull();
  });
});

describe("a workflow's traces read against its current design", () => {
  const design = ["cart", "pay", "done"];

  it("lights what the design still holds and names the traced steps that left it", () => {
    const read = presentTrace({ steps: new Set(["pay", "shipping"]), edges: new Set(["cart>pay", "pay>shipping"]) }, design);
    expect([...read.steps]).toEqual(["pay"]);
    expect([...read.edges]).toEqual(["cart>pay"]);
    expect(read.gone).toEqual(["shipping"]);
  });

  it("lights nothing where every traced step has left, and keeps a whole trace whole", () => {
    expect(presentTrace({ steps: new Set(["shipping"]), edges: new Set(["shipping>done"]) }, design)).toEqual({ steps: new Set(), edges: new Set(), gone: ["shipping"] });
    expect(presentTrace({ steps: new Set(["cart"]), edges: new Set(["cart>pay"]) }, design)).toEqual({ steps: new Set(["cart"]), edges: new Set(["cart>pay"]), gone: [] });
  });
});
