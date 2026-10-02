import { BUILTIN_WORKFLOW_TEMPLATES } from "@forge/contracts/workflow-templates";
import { describe, expect, it } from "vitest";
import type { WorkflowBody } from "../types";
import design from "./hop-discharge.fixture.json";
import { layoutView } from "./layout";
import { readCanvas, templateFor } from "./model";
import { buildView } from "./view";

// The HOP discharge design as dev stores it: 16 steps, 23 contracts, ordered by `after`.
const doc = design as unknown as WorkflowBody;

describe("the HOP discharge design on the canvas", () => {
  const template = templateFor(doc, BUILTIN_WORKFLOW_TEMPLATES);
  const c = readCanvas(doc, template);

  it("resolves to operational-flow and bands every step", () => {
    expect(template?.id).toBe("operational-flow");
    expect(c.bands.flatMap((b) => b.steps)).toHaveLength(16);
  });

  it("lays out all 16 steps as placed nodes when every band is open", async () => {
    const view = buildView(c, { lod: 2, expanded: new Set(c.bands.map((b) => b.id)), open: new Set() });
    expect(view.nodes.filter((n) => n.kind === "step")).toHaveLength(16);
    const rows = new Map(c.bands.map((b, i) => [b.id, i]));
    const placed = await layoutView({
      view,
      sizes: new Map(),
      labels: new Map(),
      partition: (key) => rows.get(c.bandOf.get(key) ?? "") ?? 0,
      direction: "down",
    });
    const ids = [...placed.nodes.keys()].sort();
    expect(ids).toEqual(doc.steps.map((s) => s.id).sort());
    for (const box of placed.nodes.values()) {
      expect(Number.isFinite(box.x) && Number.isFinite(box.y)).toBe(true);
      expect(box.width).toBeGreaterThan(0);
    }
    expect(placed.edges.size).toBe(view.edges.length);
    expect(view.edges.length).toBeGreaterThan(0);
  });

  it("centres the folded band cards on one axis, the first band included", async () => {
    const view = buildView(c, { lod: 0, expanded: new Set(), open: new Set() });
    const rows = new Map(c.bands.map((b, i) => [b.id, i]));
    const bandOfKey = (key: string) => {
      const v = view.nodes.find((n) => n.key === key);
      return v?.kind === "band" ? v.band : "";
    };
    const placed = await layoutView({
      view,
      sizes: new Map(view.nodes.map((n) => [n.key, { width: 340, height: 96 }])),
      labels: new Map(view.edges.map((e) => [e.key, `${e.src.length} links`])),
      partition: (key) => rows.get(bandOfKey(key)) ?? 0,
      direction: "down",
    });
    const centres = [...placed.nodes.values()].map((p) => p.x + p.width / 2);
    expect(Math.max(...centres) - Math.min(...centres)).toBeLessThan(60);
  });

  it("folds into one card per band when no band is open", () => {
    const view = buildView(c, { lod: 0, expanded: new Set(), open: new Set() });
    expect(view.nodes.map((n) => n.kind)).toEqual(c.bands.map(() => "band"));
  });
});
