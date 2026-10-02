import { BUILTIN_WORKFLOW_TEMPLATES } from "@forge/contracts/workflow-templates";
import { describe, expect, it } from "vitest";
import type { WorkflowEdgeContract, WorkflowStep } from "../types";
import { type Canvas, edgeText, pathOf, readCanvas, searchSteps, templateFor, walkOrder } from "./model";
import { bandKey, buildView, lodOf, mergedLabel } from "./view";

const journey = BUILTIN_WORKFLOW_TEMPLATES.find((t) => t.id === "journey-bands");
const machine = BUILTIN_WORKFLOW_TEMPLATES.find((t) => t.id === "state-machine");
if (!journey || !machine) throw new Error("built-ins lost journey-bands or state-machine");

const step = (id: string, type: string, after: string[] = [], extra: Partial<WorkflowStep["node"]> = {}): WorkflowStep => ({
  id,
  does: `does ${id}`,
  status: "current",
  after,
  evidence: null,
  node: { type, label: `Label ${id}`, ...extra },
});

const steps = [
  step("discharged", "EVENT"),
  step("history", "CONTEXT", ["discharged"]),
  step("risk", "RULE", ["history"], { conditions: [{ when: "score over 7", result: "high" }] }),
  step("case", "CASE", ["risk"]),
  step("call", "ACTION", ["case"], { owner: "nurse" }),
  step("escalate", "TASK", ["risk"]),
  step("done", "OUTCOME", ["call"]),
];
const edges: WorkflowEdgeContract[] = [
  { from: "risk", to: "escalate", kind: "escalation", label: "very high" },
  { from: "case", to: "call", label: "open case" },
  { from: "done", to: "risk", kind: "feedback", label: "re-check", reevaluates: "risk" },
];
const doc = { title: "t", summary: "s", kind: "flow" as const, flow: "f", steps, edges };
const c: Canvas = readCanvas(doc, journey);

describe("a design read through its template", () => {
  it("puts each step in its type's home band, in the template's band order, dropping empty bands", () => {
    expect(c.bands.map((b) => b.id)).toEqual(["trigger", "understand", "decide", "organise", "act", "result"]);
    expect(c.bandOf.get("escalate")).toBe("organise");
  });

  it("collects a step naming no band of the template under Unplaced instead of dropping it", () => {
    const stray = readCanvas({ ...doc, steps: [...steps, step("x", "EVENT", [], { band: "nowhere" })] }, journey);
    expect(stray.bands.at(-1)).toMatchObject({ id: "__unplaced", steps: ["x"] });
  });

  it("draws a template that is not layered-bands with no bands at all", () => {
    expect(readCanvas({ ...doc, steps: [step("a", "STATE")], edges: [] }, machine).bands).toEqual([]);
  });

  it("reads every line's kind from the template, the default where the design names none", () => {
    const kinds = Object.fromEntries(c.edges.map((e) => [e.id, e.kind.id]));
    expect(kinds).toMatchObject({ "case>call": "flow", "risk>escalate": "escalation", "done>risk": "feedback" });
    expect(edgeText(c.edges.find((e) => e.id === "case>call") as Canvas["edges"][number])).toBe("open case");
  });

  it("renders only the design's words: a line with no label or condition carries none", () => {
    expect(edgeText(c.edges.find((e) => e.id === "discharged>history") as Canvas["edges"][number])).toBe("");
  });
});

describe("templateFor", () => {
  const all = BUILTIN_WORKFLOW_TEMPLATES;
  it("reads a v2 design stored before templates as journey-bands@1", () => {
    expect(templateFor({ version: 2 }, all)?.id).toBe("journey-bands");
  });
  it("gives a v1 design no template", () => {
    expect(templateFor({ version: 1 }, all)).toBeNull();
  });
  it("finds the exact version a design names, and none for one the project does not hold", () => {
    expect(templateFor({ version: 2, template: { id: "ux-flow", version: 1 } }, all)?.id).toBe("ux-flow");
    expect(templateFor({ version: 2, template: { id: "ux-flow", version: 9 } }, all)).toBeNull();
  });
});

describe("walk-through and path focus", () => {
  it("walks every step after the ones it comes after, ties in the design's order", () => {
    expect(walkOrder(c)).toEqual(["discharged", "history", "risk", "case", "call", "escalate", "done"]);
  });

  it("walks a cycle's leftovers at the end instead of losing them", () => {
    const loop = readCanvas({ ...doc, steps: [step("a", "EVENT", ["b"]), step("b", "EVENT", ["a"])], edges: [] }, journey);
    expect(walkOrder(loop)).toEqual(["a", "b"]);
  });

  it("extends the path along solid forward lines only; a dashed escalation is lit but not followed", () => {
    const p = pathOf(c, "call");
    expect([...p.nodes].sort()).toEqual(["call", "case", "discharged", "done", "history", "risk"]);
    expect(p.nodes.has("escalate")).toBe(false);
    const e = pathOf(c, "risk");
    expect(e.edges.has("risk>escalate")).toBe(true);
    expect(e.edges.has("done>risk")).toBe(true);
  });

  it("finds steps by label, owner and rule wording", () => {
    expect(searchSteps(c, "nurse")).toEqual(["call"]);
    expect(searchSteps(c, "score over")).toEqual(["risk"]);
    expect(searchSteps(c, "  ")).toEqual([]);
  });
});

describe("folding and semantic zoom", () => {
  it("switches level at 45% and 95%", () => {
    expect([lodOf(0.44), lodOf(0.45), lodOf(0.94), lodOf(0.95)]).toEqual([0, 1, 1, 2]);
  });

  it("folds every band into one card by default, merging the lines between folded bands", () => {
    const v = buildView(c, { lod: 1, expanded: new Set(), open: new Set() });
    expect(v.nodes.every((n) => n.kind === "band")).toBe(true);
    const organiseToAct = v.edges.find((e) => e.key === `agg:${bandKey("organise")}>${bandKey("act")}`);
    expect(organiseToAct?.merged).toBe(true);
    expect(v.edges.some((e) => e.src.some((s) => s.kind.direction === "return"))).toBe(false);
  });

  it("opens a band to its steps only from level 1, and keys a folded band's steps to its card", () => {
    const at0 = buildView(c, { lod: 0, expanded: new Set(["decide"]), open: new Set() });
    expect(at0.nodes.some((n) => n.kind === "step")).toBe(false);
    const at1 = buildView(c, { lod: 1, expanded: new Set(["decide", "organise"]), open: new Set() });
    expect(at1.keyOf.get("risk")).toBe("risk");
    expect(at1.keyOf.get("call")).toBe(bandKey("act"));
    expect(at1.edges.find((e) => e.key === "risk>escalate")?.merged).toBe(false);
  });

  it("names up to two merged labels, then how many more", () => {
    const e = { key: "k", from: "a", to: "b", merged: true, src: c.edges.slice(0, 3) };
    const text = (x: Canvas["edges"][number]) => x.id;
    expect(mergedLabel(e, text)).toBe(`${c.edges[0]?.id} +2 more`);
    expect(mergedLabel({ ...e, src: c.edges.slice(0, 2) }, text)).toBe(`${c.edges[0]?.id} · ${c.edges[1]?.id}`);
  });
});
