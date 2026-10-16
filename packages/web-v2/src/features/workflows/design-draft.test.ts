// A design as the editor holds it: ids read from a person's words as core takes them, the fields a
// template owes, a step taken out with every line naming it, a save that keeps what it did not edit,
// and core's refusals read back onto the step or line their path names.

import { BUILTIN_WORKFLOW_TEMPLATES, type WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { WORKFLOW_V2_SCHEMA_ID } from "@forge/contracts/workflows";
import { describe, expect, it } from "vitest";
import { addedEdge, addedStep, bandsOf, documentOf, edgeFieldsOf, firstTypeOf, flowOf, nextTypeOf, kindOf, newDesign, nodeFieldsOf, refusalsUnder, removedStep, shapeOf, stepIdOf, withNodeField } from "./design-draft";
import type { DesignDocument, WorkflowStep } from "./types";

const template = (id: string) => BUILTIN_WORKFLOW_TEMPLATES.find((x) => x.id === id) as WorkflowTemplate;
const FLOW = /^[a-z][a-z0-9-]{0,62}$/;
const STEP = /^[a-z][a-z0-9_-]{0,62}$/;

const doc = (steps: WorkflowStep[], edges: DesignDocument["edges"] = []): DesignDocument => ({
  $schema: WORKFLOW_V2_SCHEMA_ID,
  version: 2,
  project: "p1",
  flow: "orders",
  kind: "flow",
  title: "Orders",
  summary: "An order is taken and shipped.",
  template: { id: "operational-flow", version: 1 },
  steps,
  edges,
  writtenBy: {},
});
const step = (id: string, after: string[] = [], node: WorkflowStep["node"] = { type: "TASK", label: id }): WorkflowStep => ({ id, does: `${id} happens`, after, node });

describe("ids read from a person's words", () => {
  it("folds a Vietnamese title to a flow core takes", () => {
    expect(flowOf("Đặt hàng & giao hàng")).toBe("dat-hang-giao-hang"); // i18n-allow: a Vietnamese title is the case the flow is folded from
    expect(flowOf("Đặt hàng & giao hàng")).toMatch(FLOW); // i18n-allow: a Vietnamese title is the case the flow is folded from
  });

  it("starts an id that would start with a digit or be empty with a letter", () => {
    expect(flowOf("2024 refunds")).toBe("flow-2024-refunds");
    expect(flowOf("!!!")).toBe("flow");
    expect(stepIdOf("1st check", new Set())).toBe("step-1st-check");
    for (const id of [flowOf("2024 refunds"), flowOf("!!!"), stepIdOf("1st check", new Set()), stepIdOf("", new Set())]) expect(id).toMatch(/^[a-z]/);
  });

  it("numbers a step id another step already holds, never reusing one", () => {
    expect(stepIdOf("Review", new Set(["review", "review-2"]))).toBe("review-3");
    expect(stepIdOf("Review", new Set(["review", "review-2"]))).toMatch(STEP);
  });

  it("keeps an id within core's length at the longest title", () => {
    expect(flowOf("a".repeat(200)).length).toBeLessThanOrEqual(63);
    expect(stepIdOf("b".repeat(200), new Set()).length).toBeLessThanOrEqual(63);
  });
});

describe("what a template owes", () => {
  it("reads a state-machine template as a state design and every other as a flow", () => {
    expect(kindOf(template("state-machine"))).toBe("state");
    expect(kindOf(template("operational-flow"))).toBe("flow");
  });

  it("names a type's owed fields beyond the label every step is given", () => {
    expect(nodeFieldsOf(template("operational-flow"), "TASK")).toEqual(["owner", "sla", "idempotency"]);
    expect(nodeFieldsOf(template("operational-flow"), "NOPE")).toEqual([]);
    expect(nodeFieldsOf(null, "TASK")).toEqual([]);
  });

  it("starts a new step on the template's entry type, and reads its bands from the template or the design", () => {
    expect(firstTypeOf(template("state-machine"))).toBe("INITIAL");
    expect(nextTypeOf(template("state-machine"))).toBe("STATE");
    expect(bandsOf(template("operational-flow"), {}).length).toBeGreaterThan(0);
    expect(bandsOf(template("data-flow"), { lanes: [{ id: "lane-1", label: "Clinic" }] })).toEqual([{ id: "lane-1", label: "Clinic" }]);
    expect(bandsOf(template("state-machine"), {})).toEqual([]);
  });

  it("writes each owed field the way its value is shaped, and keeps what an agent draws", () => {
    expect(["purpose", "inputs", "conditions", "variant", "persona", "wireframe", "mapping"].map(shapeOf)).toEqual(["text", "list", "conditions", "variant", "persona", "kept", "kept"]);
    expect(edgeFieldsOf(template("ux-flow"), "navigates")).not.toContain("label");
  });
});

describe("a design written whole", () => {
  it("is a version-2 document with its first step and no stamps", () => {
    const made = newDesign({ projectId: "p1", flow: "orders", title: " Orders ", summary: " Taken and shipped ", template: template("operational-flow"), start: { first: { does: " An order arrives ", node: { type: "EVENT", label: " Order placed ", event: "order.placed" } } } });
    expect(made).toMatchObject({ $schema: WORKFLOW_V2_SCHEMA_ID, version: 2, project: "p1", flow: "orders", kind: "flow", title: "Orders", summary: "Taken and shipped", template: { id: "operational-flow", version: 1 } });
    expect(made.steps).toEqual([{ id: "order-placed", does: "An order arrives", after: [], node: { type: "EVENT", label: "Order placed", event: "order.placed" } }]);
    expect(documentOf({ ...made, version: 2, id: "w1", createdAt: "x", updatedAt: "y" })).not.toHaveProperty("id");
  });

  it("starts from an example with its steps and lines, leaving out what points at the example's other designs", () => {
    const example = { ...doc([step("a", [], { type: "STATE", label: "A", refs: [{ template: "ux-flow", flow: "x", step: "y" }], wireframe: { attachment: "b0" }, owner: "Desk" })], [{ from: "a", to: "a" }]), kind: "state" as const, lanes: [{ id: "l", label: "L" }] };
    const made = newDesign({ projectId: "p9", flow: "mine", title: "Mine", summary: "S", template: template("state-machine"), start: { example } });
    expect(made).toMatchObject({ project: "p9", flow: "mine", title: "Mine", kind: "state", template: { id: "state-machine", version: 1 }, lanes: [{ id: "l", label: "L" }], edges: [{ from: "a", to: "a" }] });
    expect(made.steps[0]?.node).toEqual({ type: "STATE", label: "A", owner: "Desk" });
  });

  it("keeps every field the editor did not touch, an agent's wireframe among them", () => {
    const screen = step("home", [], { type: "SCREEN", label: "Home", wireframe: { attachment: "a1" }, refs: [{ template: "ux-flow", flow: "x", step: "y" }] });
    const edited = withNodeField(screen, "label", "Start");
    expect(edited.node).toEqual({ type: "SCREEN", label: "Start", wireframe: { attachment: "a1" }, refs: [{ template: "ux-flow", flow: "x", step: "y" }] });
  });

  it("takes an emptied field away rather than sending it empty", () => {
    expect(withNodeField(step("a"), "owner", "")).toEqual({ ...step("a"), node: { type: "TASK", label: "a" } });
    expect(withNodeField(step("a"), "inputs", [])).toEqual(step("a"));
  });

  it("takes a step out with every after and line that names it", () => {
    const d = doc([step("a"), step("b", ["a"]), step("c", ["a", "b"])], [{ from: "a", to: "b" }, { from: "b", to: "c", label: "on" }, { kind: "back", from: "c", to: "a" }]);
    const out = removedStep(d, "b");
    expect(out.steps.map((s) => [s.id, s.after])).toEqual([["a", []], ["c", ["a"]]]);
    expect(out.edges).toEqual([{ kind: "back", from: "c", to: "a" }]);
  });

  it("appends a step after the last one, its id unique, and a line between the first and last", () => {
    const d = addedStep(doc([step("review")]), "Review", "TASK");
    expect(d.steps[1]).toEqual({ id: "review-2", does: "Review", after: ["review"], node: { type: "TASK", label: "Review" } });
    expect(addedEdge(d).edges).toEqual([{ from: "review", to: "review-2" }]);
  });
});

describe("core's refusals read onto a step or line", () => {
  const refusals = [
    { path: "/steps/1/does", detail: "says nothing" },
    { path: "/steps/1/node", detail: "names no type" },
    { path: "/steps/10/after/0", detail: "dangles" },
    { path: "/edges/0/to", detail: "names no step" },
  ];

  it("gives each field its own words and the rest to the item, never another item's", () => {
    const second = refusalsUnder(refusals, "/steps/1");
    expect(second.any).toBe(true);
    expect(second.at("does")).toBe("says nothing");
    expect(second.rest(["does", "node/label"])).toBe("names no type");
    // /steps/10 is not under /steps/1
    expect(second.at("after")).toBeUndefined();
    expect(refusalsUnder(refusals, "/steps/0").any).toBe(false);
    expect(refusalsUnder(refusals, "/edges/0").at("to")).toBe("names no step");
  });
});
