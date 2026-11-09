// The focus both workflow canvases share (simplify census C2-17): a walk visits the design in reading
// order and ends past its last step, Escape ends a walk before it clears a selection, and a selected
// line lights its two ends whether named by its id or by the merged key a folded band draws.
//
// @direct-test-of packages/web-v2/src/features/workflows/canvas/flow-canvas.tsx
// @direct-test-of packages/web-v2/src/features/workflows/canvas/use-canvas-layout.ts

import { act, render, renderHook } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { productCopy } from "@/lib/i18n/product-copy";
import { compactView } from "./flow-canvas";
import { type Canvas, readCanvas } from "./model";
import { focusChrome, litOf, presentTrace, useStepFocus } from "./step-focus";
import { WorkflowCanvas } from "./workflow-canvas";

const step = (id: string, after: string[] = []) => ({ id, title: `Step ${id}`, after });
const c: Canvas = readCanvas(
  { title: "T", summary: "", kind: "flow", steps: [step("a"), step("b", ["a"]), step("c", ["b"])], edges: [], flow: [] } as unknown as Canvas["doc"],
  null,
  productCopy("en"),
);

describe("the shared canvas focus", () => {
  it("walks in reading order, remembers what it visited, and ends past the last step with nothing selected", () => {
    const { result } = renderHook(() => useStepFocus(c));
    expect(result.current.order).toEqual(["a", "b", "c"]);
    let id: string | null = null;
    act(() => {
      id = result.current.advance(1);
    });
    expect(id).toBe("b");
    expect(result.current.walking).toBe(true);
    expect([...result.current.visited]).toEqual(["b"]);
    act(() => {
      result.current.setSelection({ step: "b" });
      id = result.current.advance(3);
    });
    expect(id).toBeNull();
    expect(result.current.walking).toBe(false);
    expect(result.current.selection).toBeNull();
    expect(result.current.advance(-1)).toBeNull();
  });

  it("ends a walk on the first dismiss and clears the selection on the next", () => {
    const { result } = renderHook(() => useStepFocus(c));
    act(() => {
      result.current.advance(0);
      result.current.setSelection({ step: "a" });
    });
    act(() => {
      result.current.dismiss();
    });
    expect(result.current.walk).toBeNull();
    expect(result.current.visited.size).toBe(0);
    act(() => result.current.setSelection({ step: "a" }));
    act(() => {
      result.current.dismiss();
    });
    expect(result.current.selection).toBeNull();
  });

  it("lights a selected line's two ends, by its id or by a folded band's merged key", () => {
    const { result } = renderHook(() => useStepFocus(c));
    act(() => result.current.setSelection({ edge: "a>b" }));
    expect([...(result.current.focus?.nodes ?? [])]).toEqual(["a", "b"]);
    act(() => result.current.setSelection({ edge: "agg:b>c" }));
    expect([...(result.current.focus?.nodes ?? [])]).toEqual(["b", "c"]);
  });

  it("finds steps by the words on them", () => {
    const { result } = renderHook(() => useStepFocus(c));
    act(() => result.current.setQuery("step b"));
    expect([...result.current.hits]).toEqual(["b"]);
  });

  // ISS-460 (REQ-35 BC-3): a page names steps and lines to light with nothing clicked, the rest dimmed
  it("lights a page's highlight with nothing clicked, the rest dimmed, and a click still takes the light", () => {
    const highlight = { steps: new Set(["a"]), edges: new Set(["b>c"]) };
    const { result } = renderHook(() => useStepFocus(c));
    const lit = litOf(result.current.focus, highlight);
    expect([...(lit?.nodes ?? [])].sort()).toEqual(["a", "b", "c"]);
    expect([...(lit?.edges ?? [])]).toEqual(["b>c"]);
    const chrome = (h: typeof highlight | null) => focusChrome(result.current, { c, reveal: () => {}, decision: null, compact: true, highlight: h });
    expect(chrome(highlight).dim).toBe(true);
    expect(chrome(null).dim).toBe(false);
    expect(litOf(result.current.focus, null)).toBeNull();
    act(() => result.current.setSelection({ edge: "a>b" }));
    expect([...(litOf(result.current.focus, highlight)?.nodes ?? [])].sort()).toEqual(["a", "b"]);
    expect([...(litOf(result.current.focus, highlight)?.edges ?? [])]).toEqual(["a>b"]);
  });
});

describe("a workflow's traces read against its current design", () => {
  const design = ["cart", "pay", "done"];

  it("lights what the design still holds and names the traced steps that left it", () => {
    const read = presentTrace({ steps: new Set(["pay", "shipping"]), edges: new Set(["cart>pay", "pay>shipping"]) }, design);
    expect([...read.steps]).toEqual(["pay"]);
    expect([...read.edges]).toEqual(["cart>pay"]);
    expect(read.gone).toEqual(["shipping"]);
  });

  it("lights nothing where every traced step has left, and keeps a whole trace whole", () => {
    expect(presentTrace({ steps: new Set(["shipping"]), edges: new Set(["shipping>done"]) }, design)).toEqual({ steps: new Set(), edges: new Set(), gone: ["shipping"] });
    expect(presentTrace({ steps: new Set(["cart"]), edges: new Set(["cart>pay"]) }, design)).toEqual({ steps: new Set(["cart"]), edges: new Set(["cart>pay"]), gone: [] });
  });
});

// REQ-67 BC-2 (ISS-1176): a requirement's picture lights the steps its criteria touch as a state of
// their own on the drawn canvas, not only listed: each traced card marked traced, every other one
// dimmed, as the requirement page draws its linked workflow (`requirement-workflow-picture.tsx`)
describe("a page's highlight on the drawn canvas", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks each traced step lit and dims every other step, with nothing clicked", () => {
    const { container } = render(
      <ReactFlowProvider>
        <WorkflowCanvas doc={c.doc} template={null} highlight={{ steps: new Set(["b"]), edges: new Set() }} compact />
      </ReactFlowProvider>,
    );
    const cards = [...container.querySelectorAll<HTMLElement>("[data-testid=workflow-node]")];
    const state = (id: string) => cards.find((n) => n.dataset.step === id);
    expect(cards.map((n) => n.dataset.step).sort()).toEqual(["a", "b", "c"]);
    expect([state("a"), state("b"), state("c")].map((n) => [n?.dataset.traced, n?.dataset.rel])).toEqual([
      ["false", "false"],
      ["true", "true"],
      ["false", "false"],
    ]);
    expect(container.querySelector("[data-dim]")?.getAttribute("data-dim")).toBe("true");
  });
});

// REQ-67 BC-2 at a phone's width: a requirement's picture wider than its pane opens on the first lit step,
// not on the drawing's first, so the light is in view without a sideways scroll
describe("where a compact pane opens", () => {
  const box = (i: number) => ({ x: i * 260, y: 0, width: 200, height: 60 });
  const [cart, , pay, confirm, ship] = [0, 1, 2, 3, 4].map(box);
  const row = [0, 1, 2, 3, 4].map(box);
  const shownAt = (view: ReturnType<typeof compactView>, b = cart) => view.viewport.x + (b?.x ?? 0) * view.viewport.zoom;

  it("opens a drawing wider than the pane on its first lit step, never past the drawing's right end", () => {
    expect(pay && confirm && ship).toBeTruthy();
    expect(shownAt(compactView(390, row, pay && confirm ? [pay, confirm] : []), pay)).toBe(16);
    const last = compactView(390, row, ship ? [ship] : []);
    expect(shownAt(last, ship) + 200 * last.viewport.zoom).toBeCloseTo(390 - 16);
  });

  it("opens on the drawing's first step where nothing is lit, and centres a drawing that fits", () => {
    expect(shownAt(compactView(390, row))).toBe(16);
    expect(shownAt(compactView(1440, row, confirm ? [confirm] : []))).toBe((1440 - 1240) / 2);
  });
});
