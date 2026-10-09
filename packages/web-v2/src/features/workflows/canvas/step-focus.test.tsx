// The focus both workflow canvases share (simplify census C2-17): a walk visits the design in reading
// order and ends past its last step, Escape ends a walk before it clears a selection, and a selected
// line lights its two ends whether named by its id or by the merged key a folded band draws.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { productCopy } from "@/lib/i18n/product-copy";
import { type Canvas, readCanvas } from "./model";
import { focusChrome, litOf, useStepFocus } from "./step-focus";

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
    act(() => result.current.dismiss());
    expect(result.current.walk).toBeNull();
    expect(result.current.visited.size).toBe(0);
    act(() => result.current.setSelection({ step: "a" }));
    act(() => result.current.dismiss());
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
