// The focus both workflow canvases share (simplify census C2-17): a walk visits the design in reading
// order and ends past its last step, Escape ends a walk before it clears a selection, and a selected
// line lights its two ends whether named by its id or by the merged key a folded band draws.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type Canvas, readCanvas } from "./model";
import { useStepFocus } from "./step-focus";

const step = (id: string, after: string[] = []) => ({ id, title: `Step ${id}`, after });
const c: Canvas = readCanvas(
  { title: "T", summary: "", kind: "flow", steps: [step("a"), step("b", ["a"]), step("c", ["b"])], edges: [], flow: [] } as unknown as Canvas["doc"],
  null,
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
});
