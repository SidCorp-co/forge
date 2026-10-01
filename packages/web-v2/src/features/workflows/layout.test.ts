import { describe, expect, it } from "vitest";
import { layoutOf, walkedOf } from "./layout";
import type { WorkflowStep } from "./types";

const step = (id: string, after: string[], reading?: "walked" | "not_walked"): WorkflowStep => ({
  id,
  does: id,
  status: "current",
  after,
  evidence: reading ? { file: `src/${id}.ts`, coverage: { reading, atSha: "a".repeat(40) } } : null,
});

const release = [
  step("stamp", [], "walked"),
  step("close", ["stamp"], "walked"),
  step("deploy", ["stamp"], "walked"),
  step("reap", ["close"], "not_walked"),
];

describe("a stored workflow drawn as a diagram", () => {
  it("places each step one column after the latest step it comes after", () => {
    const l = layoutOf(release, "flow");
    const x = Object.fromEntries(l.steps.map((p) => [p.step.id, p.x]));
    expect(x.stamp).toBe(0);
    expect(x.close).toBe(x.deploy);
    expect(x.reap).toBeGreaterThan(x.close as number);
  });

  it("draws one edge per after, and none for a step it cannot find", () => {
    const l = layoutOf([...release, step("orphan", ["missing"])], "flow");
    expect(l.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["stamp>close", "stamp>deploy", "close>reap"]);
  });

  it("stacks a state machine top to bottom", () => {
    const l = layoutOf([step("draft", []), step("open", ["draft"])], "state");
    const [a, b] = l.steps;
    expect(a?.x).toBe(b?.x);
    expect((b?.y ?? 0) > (a?.y ?? 0)).toBe(true);
  });

  it("counts only the steps the integration suite walked", () => {
    expect(walkedOf(release)).toEqual({ walked: 3, total: 4 });
  });
});
