// REQ-35 BC-7 and the decision on question 20c74d56 (2026-10-14, (a)), on the design canvas: a
// proposal awaiting its reader opens with Changes on, and a design opens with its bands folded, so a
// folded band says how many of its steps the proposal changes, marked as changed; otherwise the
// reader sees the switch on and no change until they open the band the change sits in.
//
// @direct-test-of packages/web-v2/src/features/workflows/canvas/use-canvas-layout.ts
// @direct-test-of packages/web-v2/src/features/workflows/canvas/nodes.tsx

import { operationalFlow } from "@forge/contracts/workflow-template-operational";
import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { productCopy } from "@/lib/i18n/product-copy";
import type { DesignDiff, StepMark } from "../design-diff";
import { type Canvas, readCanvas } from "./model";
import { type BandNodeData, NODE_TYPES } from "./nodes";
import { type Decoration, stepData } from "./use-canvas-layout";

const step = (id: string, type: string, after: string[] = []) => ({ id, does: `Step ${id}`, after, node: { type, label: `Step ${id}` } });
const c: Canvas = readCanvas(
  { title: "T", summary: "", kind: "flow", steps: [step("order", "EVENT"), step("rule", "RULE", ["order"]), step("state", "STATE", ["rule"])], edges: [] } as unknown as Canvas["doc"],
  operationalFlow,
  productCopy("en"),
);

const diffOf = (steps: Record<string, StepMark>): DesignDiff => ({ steps: new Map(Object.entries(steps)), edges: new Map(), removed: [] });
const decoration = (diff: DesignDiff | null): Decoration => ({
  selected: null,
  selectedEdge: null,
  relNodes: null,
  relEdges: null,
  traced: null,
  hits: new Set(),
  visited: new Set(),
  contract: false,
  diff,
  health: null,
});
const band = (id: string, diff: DesignDiff | null) => stepData(c, { key: `band:${id}`, kind: "band", band: id }, decoration(diff)) as BandNodeData;

const BandCard = NODE_TYPES.band as unknown as (p: Pick<ComponentProps<typeof NODE_TYPES.band>, "data">) => React.JSX.Element;
const drawn = (data: BandNodeData) =>
  render(
    <ReactFlowProvider>
      <BandCard data={data} />
    </ReactFlowProvider>,
  );

describe("a folded band says what the proposal changes inside it", () => {
  it("counts the steps it folds that the diff marks, added and changed alike", () => {
    expect(c.bands.map((b) => [b.id, b.steps])).toEqual([
      ["trigger", ["order"]],
      ["decide", ["rule", "state"]],
    ]);
    const diff = diffOf({ rule: "changed", state: "added" });
    expect(band("decide", diff).changed, "a band holding two changed steps does not say so").toBe(2);
    expect(band("trigger", diff).changed, "a band no change touches counts a change").toBe(0);
  });

  it("counts nothing while Changes is off", () => {
    expect(band("decide", null).changed, "a band counts changes while Changes is off").toBe(0);
  });

  it("draws a band holding a change as changed, with how many", () => {
    drawn(band("decide", diffOf({ rule: "changed" })));
    expect(screen.getByTestId("workflow-band")).toHaveAttribute("data-mark", "changed");
    expect(screen.getByTestId("workflow-band-changed")).toHaveTextContent("1 changed");
  });

  it("draws a band no change touches as it stands", () => {
    drawn(band("trigger", diffOf({ rule: "changed" })));
    expect(screen.getByTestId("workflow-band")).not.toHaveAttribute("data-mark");
    expect(screen.queryByTestId("workflow-band-changed")).toBeNull();
  });
});
