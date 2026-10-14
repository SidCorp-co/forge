// REQ-35 BC-7 and the decision on question 20c74d56 (2026-10-14, (a)), on the system-context canvas:
// a proposal awaiting its reader opens with Changes on, and the Boundaries view folds an outside
// boundary into one box, so a folded box says how many of the steps it folds the proposal changes,
// marked as changed; otherwise the change sits inside a box that looks untouched.
//
// @direct-test-of packages/web-v2/src/features/workflows/canvas/c4-canvas.tsx
// @direct-test-of packages/web-v2/src/features/workflows/canvas/c4-nodes.tsx

import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { type Diagram, layoutView } from "../c4/layout";
import { FOCAL, viewOf } from "../c4/view";
import type { DesignDiff, StepMark } from "../design-diff";
import type { GraphNode, SystemGraph } from "../types";
import { c4Nodes } from "./c4-canvas";
import { type C4BoxData, C4_NODE_TYPES } from "./c4-nodes";

const node = (id: string, kind: GraphNode["kind"], boundary: string | null): GraphNode => ({
  id,
  kind,
  title: id,
  name: id,
  purpose: "",
  owner: null,
  boundary,
  integration: null,
  mark: null,
  removed: false,
});

/** A clinic's system: one person, the app in scope, and two payment providers the Boundaries view folds into one box. */
const graph: SystemGraph = {
  workflowId: "w-1",
  revision: 2,
  against: 1,
  focal: { boundary: null, title: "Clinic app", tip: "", purpose: "", parts: ["app"] },
  nodes: [node("clerk", "person", null), node("app", "system", null), node("card", "external", "payments"), node("bank", "external", "payments")],
  relationships: [],
  boundaries: [{ id: "outside:payments", lane: "payments", side: "outside", label: "Payments", tip: "", members: ["card", "bank"] }],
  facts: { people: [], externals: 2, boundaries: [], namedBoundaries: 1 },
};

const diffOf = (steps: Record<string, StepMark>): DesignDiff => ({ steps: new Map(Object.entries(steps)), edges: new Map(), removed: [] });

async function diagram(): Promise<Diagram> {
  const v = viewOf(graph, "context", "boundaries");
  if (!v) throw new Error("the fixture has no system in scope");
  return layoutView(v);
}

const boxes = (d: Diagram, diff: DesignDiff | null) =>
  new Map(c4Nodes(d, { step: null, focus: null, hits: new Set(), diff, health: null, onFold: null }).filter((n) => n.type === "c4box").map((n) => [n.id, n.data as C4BoxData]));

const BoxCard = C4_NODE_TYPES.c4box as unknown as (p: Pick<ComponentProps<typeof C4_NODE_TYPES.c4box>, "data">) => React.JSX.Element;
const drawn = (data: C4BoxData) =>
  render(
    <ReactFlowProvider>
      <BoxCard data={data} />
    </ReactFlowProvider>,
  );

describe("a folded box says what the proposal changes inside it", () => {
  it("counts the changed steps a folded boundary holds, and marks it changed", async () => {
    const b = boxes(await diagram(), diffOf({ card: "changed" }));
    const payments = b.get("outside:payments");
    expect(payments?.box.node.kind, "the fixture's boundary is not folded").toBe("group");
    expect(payments?.changed, "a folded boundary holding a changed step does not say so").toBe(1);
    expect(payments?.mark, "a folded boundary holding a changed step is not marked").toBe("changed");
  });

  it("leaves a folded box no change touches, and a leaf's own mark, as they were", async () => {
    const b = boxes(await diagram(), diffOf({ card: "changed", clerk: "added" }));
    expect(b.get(FOCAL)?.changed, "a folded box no change touches counts a change").toBe(0);
    expect(b.get(FOCAL)?.mark).toBeNull();
    expect(b.get("clerk")?.mark, "a leaf lost its own mark").toBe("added");
    expect(b.get("clerk")?.changed).toBe(0);
  });

  it("counts nothing while Changes is off", async () => {
    const b = boxes(await diagram(), null);
    expect(b.get("outside:payments")?.changed, "a folded boundary counts changes while Changes is off").toBe(0);
    expect(b.get("outside:payments")?.mark).toBeNull();
  });

  it("draws a folded boundary holding a change as changed, with how many", async () => {
    const payments = boxes(await diagram(), diffOf({ card: "changed", bank: "removed" })).get("outside:payments");
    if (!payments) throw new Error("no Payments box");
    drawn(payments);
    expect(screen.getByTestId("c4-box")).toHaveAttribute("data-mark", "changed");
    expect(screen.getByTestId("c4-changed")).toHaveTextContent("2 changed");
  });

  it("draws a folded box no change touches as it stands", async () => {
    const focal = boxes(await diagram(), diffOf({ card: "changed" })).get(FOCAL);
    if (!focal) throw new Error("no system box");
    drawn(focal);
    expect(screen.getByTestId("c4-box")).not.toHaveAttribute("data-mark");
    expect(screen.queryByTestId("c4-changed")).toBeNull();
  });
});
