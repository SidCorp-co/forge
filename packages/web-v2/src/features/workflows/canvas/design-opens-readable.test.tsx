// ISS-781 part 1 on the design canvas (REQ-10 BC-15, BC-16; REQ-12 BC-6): a design opens readable,
// every stage open and every step a full card, and its toolbar is one row that starts with Walk
// through and holds no Stages/Steps/Detail or Business/Contract switch; contract terms are the
// page's Developer view.
//
// @direct-test-of packages/web-v2/src/features/workflows/canvas/flow-canvas.tsx
// @direct-test-of packages/web-v2/src/features/workflows/canvas/controls.tsx
// @direct-test-of packages/web-v2/src/features/workflows/canvas/c4-canvas.tsx

import { operationalFlow } from "@forge/contracts/workflow-template-operational";
import { act, render, renderHook, screen, within } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { productCopy } from "@/lib/i18n/product-copy";
import { type Canvas, readCanvas } from "./model";
import { useOpenDesign } from "./flow-canvas";
import { buildView } from "./view";
import { WorkflowCanvas } from "./workflow-canvas";

const step = (id: string, type: string, after: string[] = []) => ({ id, does: `Step ${id} does its part`, after, node: { type, label: `Step ${id}`, owner: "Ops" } });
const doc = {
  title: "Onboarding",
  summary: "",
  kind: "flow",
  flow: "onboarding",
  steps: [step("order", "EVENT"), step("rule", "RULE", ["order"]), step("state", "STATE", ["rule"]), step("act", "ACTION", ["state"])],
  edges: [],
} as unknown as Canvas["doc"];
const c: Canvas = readCanvas(doc, operationalFlow, productCopy("en"));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  window.history.replaceState(null, "", "/projects/acme/workflows/onboarding");
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("a design opens readable (C5)", () => {
  it("opens with every stage open and every step a full card", () => {
    expect(c.bands.length, "the fixture has no stages to open").toBeGreaterThan(1);
    const { result } = renderHook(() => useOpenDesign(c));
    expect([...result.current.expanded].sort()).toEqual(c.bands.map((b) => b.id).sort());
    const view = buildView(c, { lod: 1, expanded: result.current.expanded, open: result.current.open });
    expect(view.nodes.filter((n) => n.kind === "band"), "a stage opens folded").toEqual([]);
    expect(view.nodes.map((n) => (n.kind === "step" ? [n.id, n.full] : [n.key, false]))).toEqual(doc.steps.map((s) => [s.id, true]));
  });

  it("opens a step the design gains while shown, and keeps what the reader folded", () => {
    const { result, rerender } = renderHook(({ cc }) => useOpenDesign(cc), { initialProps: { cc: c } });
    act(() => result.current.setOpen(new Set(["order"])));
    const grown = readCanvas({ ...doc, steps: [...doc.steps, step("result", "OUTCOME", ["act"])] }, operationalFlow, productCopy("en"));
    rerender({ cc: grown });
    expect([...result.current.open].sort()).toEqual(["act", "order", "result", "rule", "state"]);
  });
});

const canvas = () =>
  render(
    <ReactFlowProvider>
      <WorkflowCanvas doc={doc} template={operationalFlow} focus={{ on: false, onToggle: () => {} }} />
    </ReactFlowProvider>,
  );

describe("the canvas toolbar is one layer of controls (C6)", () => {
  it("starts with Walk through and holds no Stages/Steps/Detail or Business/Contract switch", () => {
    canvas();
    const bar = screen.getByTestId("canvas-toolbar");
    expect(bar.firstElementChild).toBe(within(bar).getByTestId("walk-start-bar"));
    expect(bar.textContent).not.toMatch(/Stages|Steps|Detail|Business|Contract|Focus/);
    expect(within(bar).queryAllByRole("radio")).toHaveLength(0);
    expect(bar.textContent).toMatch(/Walk through/);
    expect(bar.textContent).toMatch(/Fold all/);
  });

  it("keeps focus mode on the zoom bar, beside fit and the minimap", () => {
    canvas();
    const zoom = screen.getByRole("toolbar", { name: "Canvas" });
    expect(within(zoom).getByTestId("canvas-focus")).toBeInTheDocument();
  });
});
