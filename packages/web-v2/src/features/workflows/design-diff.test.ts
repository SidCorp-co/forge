import { BUILTIN_WORKFLOW_TEMPLATES } from "@forge/contracts/workflow-templates";
import { describe, expect, it } from "vitest";
import { designDiff, edgeKey, stepsWithRemoved } from "./design-diff";
import type { WorkflowBody } from "./types";

const body = (patch: Partial<WorkflowBody> = {}): WorkflowBody => ({
  version: 2,
  project: "p",
  flow: "f",
  kind: "flow",
  title: "F",
  summary: "s",
 
  steps: [
    { id: "a", does: "a", after: [], node: { type: "EVENT" } },
    { id: "b", does: "b", after: ["a"], node: { type: "CASE", sla: "48h" } },
  ],
  edges: [{ from: "a", to: "b", condition: "x" }],
  writtenBy: {},
  ...patch,
});

describe("what a proposed design changes against the approved one", () => {
  it("names nothing when nothing moved", () => {
    const d = designDiff(body(), body());
    expect([...d.steps]).toEqual([]);
    expect([...d.edges]).toEqual([]);
  });

  it("marks an added, a changed and a removed step, and a changed contract", () => {
    const next = body({
      steps: [
        { id: "a", does: "a", after: [], node: { type: "EVENT" } },
        { id: "c", does: "c", after: ["a"] },
      ],
      edges: [{ from: "a", to: "b", condition: "y" }],
    });
    next.steps[0] = { ...next.steps[0], node: { type: "RULE" } };
    const d = designDiff(body(), next);
    expect(Object.fromEntries(d.steps)).toEqual({ a: "changed", c: "added", b: "removed" });
    expect(d.edges.get(edgeKey("a", "b"))).toBe("changed");
    expect(stepsWithRemoved(next, d).map((s) => s.id)).toEqual(["a", "c", "b"]);
  });

  it("marks an added and a removed return edge, and reads a spelled-out implied kind as no change", () => {
    const operational = BUILTIN_WORKFLOW_TEMPLATES.find((t) => t.id === "operational-flow") ?? null;
    const back = { kind: "feeds-back" as const, from: "b", to: "a", reevaluates: "a" };
    const looped = body({ edges: [{ from: "a", to: "b", condition: "x" }, back] });
    expect(Object.fromEntries(designDiff(body(), looped).edges)).toEqual({ [edgeKey("b", "a")]: "added" });
    expect(Object.fromEntries(designDiff(looped, body()).edges)).toEqual({ [edgeKey("b", "a")]: "removed" });
    const named = body({ edges: [{ kind: "opens", from: "a", to: "b", condition: "x" }] });
    expect([...designDiff(body(), named, operational).edges]).toEqual([]);
    expect([...designDiff(body(), named).edges]).toEqual([[edgeKey("a", "b"), "changed"]]);
  });
});
