import { BUILTIN_WORKFLOW_TEMPLATES } from "@forge/contracts/workflow-templates";
import { describe, expect, it } from "vitest";
import type { WorkflowEdgeContract, WorkflowStep } from "../types";
import { type Canvas, edgeText, lineLabel, pathOf, readCanvas, searchSteps, templateFor, walkOrder } from "./model";
import { bandKey, buildView, lodOf, mergedLabel } from "./view";

const operational = BUILTIN_WORKFLOW_TEMPLATES.find((t) => t.id === "operational-flow");
const machine = BUILTIN_WORKFLOW_TEMPLATES.find((t) => t.id === "state-machine");
if (!operational || !machine) throw new Error("built-ins lost operational-flow or state-machine");

const step = (id: string, type: string, after: string[] = [], extra: Partial<WorkflowStep["node"]> = {}): WorkflowStep => ({
  id,
  does: `does ${id}`,
  status: "current",
  after,
  evidence: null,
  node: { type, label: `Label ${id}`, ...extra },
});

const steps = [
  step("his", "SOURCE"),
  step("discharged", "EVENT", ["his"]),
  step("history", "CONTEXT"),
  step("risk", "RULE", ["discharged", "history"], { conditions: [{ when: "score over 7", result: "high" }] }),
  step("state", "STATE", ["risk"]),
  step("due", "EXPECTATION", ["state"]),
  step("late", "ATTENTION", ["due"]),
  step("case", "CASE", ["risk"]),
  step("task", "TASK", ["case"], { owner: "nurse" }),
  step("call", "ACTION", ["task"]),
  step("done", "OUTCOME", ["call"]),
];
const edges: WorkflowEdgeContract[] = [
  { from: "due", to: "late", label: "overdue" },
  { from: "task", to: "call", label: "calls" },
  { from: "done", to: "history", kind: "feeds-back", label: "re-check", reevaluates: "history" },
];
const doc = { title: "t", summary: "s", kind: "flow" as const, flow: "f", steps, edges };
const c: Canvas = readCanvas(doc, operational);
const edgeOf = (id: string) => c.edges.find((e) => e.id === id) as Canvas["edges"][number];

describe("a design read through its template", () => {
  it("puts each step in its type's home band, in the template's band order, dropping empty bands", () => {
    expect(c.bands.map((b) => b.id)).toEqual(["trigger", "understand", "decide", "organise", "act", "result"]);
    expect(c.bandOf.get("late")).toBe("organise");
  });

  it("collects a step naming no band of the template under Unplaced instead of dropping it", () => {
    const stray = readCanvas({ ...doc, steps: [...steps, step("x", "EVENT", [], { band: "nowhere" })] }, operational);
    expect(stray.bands.at(-1)).toMatchObject({ id: "__unplaced", steps: ["x"] });
  });

  it("draws a template that is not layered-bands with no bands at all", () => {
    expect(readCanvas({ ...doc, steps: [step("a", "STATE")], edges: [] }, machine).bands).toEqual([]);
  });

  it("reads a line's kind from its endpoint types where the design names none", () => {
    const kinds = Object.fromEntries(c.edges.map((e) => [e.id, e.kind.id]));
    expect(kinds).toMatchObject({
      "his>discharged": "emits",
      "history>risk": "enriches",
      "task>call": "performs",
      "due>late": "breaches",
      "done>history": "feeds-back",
    });
    expect(edgeText(edgeOf("task>call"))).toBe("calls");
  });

  it("renders only the design's words: a line with no label or condition carries none", () => {
    expect(edgeText(edgeOf("discharged>risk"))).toBe("");
  });
});

describe("templateFor", () => {
  const all = BUILTIN_WORKFLOW_TEMPLATES;
  it("reads a v2 design stored before templates as operational-flow@1", () => {
    expect(templateFor({ version: 2 }, all)?.id).toBe("operational-flow");
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
    expect(walkOrder(c)).toEqual(["his", "discharged", "history", "risk", "state", "due", "late", "case", "task", "call", "done"]);
  });

  it("walks a cycle's leftovers at the end instead of losing them", () => {
    const loop = readCanvas({ ...doc, steps: [step("a", "EVENT", ["b"]), step("b", "EVENT", ["a"])], edges: [] }, operational);
    expect(walkOrder(loop)).toEqual(["a", "b"]);
  });

  it("extends the path along solid forward lines only; a dashed or dotted line is lit but not followed", () => {
    const p = pathOf(c, "call");
    expect([...p.nodes].sort()).toEqual(["call", "case", "discharged", "done", "his", "risk", "task"]);
    expect(p.nodes.has("history")).toBe(false);
    expect(p.nodes.has("late")).toBe(false);
    const due = pathOf(c, "due");
    expect(due.nodes.has("late")).toBe(true);
    expect(due.edges.has("due>late")).toBe(true);
    expect(pathOf(c, "history").edges.has("done>history")).toBe(true);
  });

  it("finds steps by label, owner and rule wording", () => {
    expect(searchSteps(c, "nurse")).toEqual(["task"]);
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
    expect(at1.edges.find((e) => e.key === "due>late")?.merged).toBe(false);
  });

  it("names a merged line by how many lines it stands for, never by their conditions", () => {
    const e = { key: "k", from: "a", to: "b", merged: true, src: c.edges.slice(0, 3) };
    expect(mergedLabel(e)).toBe("3 links");
    expect(mergedLabel({ ...e, src: c.edges.slice(0, 1) })).toBe("1 link");
  });

  it("shows a line's label, else its condition cut short with the whole of it kept for the tooltip", () => {
    const base = c.edges[0] as Canvas["edges"][number];
    const long = "case_closable AND case open AND every task resolved AND the follow-up booked";
    expect(lineLabel({ ...base, contract: { from: "a", to: "b", label: "booked", condition: long } })).toEqual({ text: "booked", full: long });
    const cut = lineLabel({ ...base, contract: { from: "a", to: "b", condition: long } });
    expect(cut.text.length).toBeLessThanOrEqual(48);
    expect(cut.text.endsWith("…")).toBe(true);
    expect(cut.full).toBe(long);
    expect(lineLabel({ ...base, contract: { from: "a", to: "b", condition: "short" } })).toEqual({ text: "short", full: null });
  });
});
