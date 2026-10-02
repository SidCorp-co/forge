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
  status: "designed",
  steps: [
    { id: "a", does: "a", status: "designed", after: [], evidence: null, node: { type: "EVENT" } },
    { id: "b", does: "b", status: "designed", after: ["a"], evidence: null, node: { type: "CASE", sla: "48h" } },
  ],
  edges: [{ from: "a", to: "b", condition: "x" }],
  drift: null,
  writtenBy: {},
  refreshedAtSha: null,
  ...patch,
});

describe("what a proposed design changes against the approved one", () => {
  it("names nothing when only the reading moved", () => {
    const built = body();
    built.steps[0] = { ...built.steps[0], status: "current" };
    const d = designDiff(body(), built);
    expect([...d.steps]).toEqual([]);
    expect([...d.edges]).toEqual([]);
  });

  it("marks an added, a changed and a removed step, and a changed contract", () => {
    const next = body({
      steps: [
        { id: "a", does: "a", status: "designed", after: [], evidence: null, node: { type: "EVENT" } },
        { id: "c", does: "c", status: "designed", after: ["a"], evidence: null },
      ],
      edges: [{ from: "a", to: "b", condition: "y" }],
    });
    next.steps[0] = { ...next.steps[0], node: { type: "RULE" } };
    const d = designDiff(body(), next);
    expect(Object.fromEntries(d.steps)).toEqual({ a: "changed", c: "added", b: "removed" });
    expect(d.edges.get(edgeKey("a", "b"))).toBe("changed");
    expect(stepsWithRemoved(next, d).map((s) => s.id)).toEqual(["a", "c", "b"]);
  });

  it("marks an added and a removed feedback edge, and reads an explicit flow kind as no change", () => {
    const back = { kind: "feedback" as const, from: "b", to: "a", reevaluates: "a" };
    const looped = body({ edges: [{ from: "a", to: "b", condition: "x" }, back] });
    expect(Object.fromEntries(designDiff(body(), looped).edges)).toEqual({ [edgeKey("b", "a")]: "added" });
    expect(Object.fromEntries(designDiff(looped, body()).edges)).toEqual({ [edgeKey("b", "a")]: "removed" });
    const named = body({ edges: [{ kind: "flow", from: "a", to: "b", condition: "x" }] });
    expect([...designDiff(body(), named).edges]).toEqual([]);
  });
});
