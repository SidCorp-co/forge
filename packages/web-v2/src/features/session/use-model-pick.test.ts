// @vitest-environment jsdom
//
// ISS-718 — the pick must outlive the send that applied it, because the row that
// proves it applied arrives one refetch later.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ModelTier } from "./types";
import { useModelPick } from "./use-model-pick";

describe("useModelPick", () => {
  it("starts untouched, so the persisted model shows through", () => {
    const { result } = renderHook(() => useModelPick("sonnet"));
    expect(result.current.pendingModel).toBeUndefined();
    expect(result.current.unsent).toBe(false);
  });

  it("a fresh pick is unsent", () => {
    const { result } = renderHook(() => useModelPick(null));
    act(() => result.current.select("opus"));
    expect(result.current.pendingModel).toBe("opus");
    expect(result.current.unsent).toBe(true);
  });

  it("keeps naming the picked model between the send and the confirming row", () => {
    const { result, rerender } = renderHook(({ p }: { p: ModelTier | null }) => useModelPick(p), {
      initialProps: { p: null as ModelTier | null },
    });
    act(() => result.current.select("opus"));
    act(() => result.current.markSent("opus"));
    // cm:why the send has resolved but the row still says what it said before, which is the whole window this hook exists to cover
    expect(result.current.pendingModel).toBe("opus");
    expect(result.current.unsent).toBe(false);

    rerender({ p: "opus" });
    expect(result.current.pendingModel).toBeUndefined();
  });

  it("holds the pick when the confirming refetch never agrees", () => {
    const { result, rerender } = renderHook(({ p }: { p: ModelTier | null }) => useModelPick(p), {
      initialProps: { p: null as ModelTier | null },
    });
    act(() => result.current.select("opus"));
    act(() => result.current.markSent("opus"));
    rerender({ p: null });
    expect(result.current.pendingModel).toBe("opus");
  });

  it("retires an explicit Default pick, which null-vs-undefined must not confuse", () => {
    const { result, rerender } = renderHook(({ p }: { p: ModelTier | null }) => useModelPick(p), {
      initialProps: { p: "opus" as ModelTier | null },
    });
    act(() => result.current.select(null));
    expect(result.current.pendingModel).toBeNull();
    expect(result.current.unsent).toBe(true);
    act(() => result.current.markSent(null));
    expect(result.current.pendingModel).toBeNull();
    rerender({ p: null });
    expect(result.current.pendingModel).toBeUndefined();
  });

  it("a second pick before the first is confirmed is unsent again", () => {
    const { result } = renderHook(() => useModelPick(null));
    act(() => result.current.select("opus"));
    act(() => result.current.markSent("opus"));
    act(() => result.current.select("haiku"));
    expect(result.current.pendingModel).toBe("haiku");
    expect(result.current.unsent).toBe(true);
  });

  it("does not mark a newer pick sent when an earlier send resolves", () => {
    const { result } = renderHook(() => useModelPick(null));
    act(() => result.current.select("opus"));
    act(() => result.current.select("haiku"));
    act(() => result.current.markSent("opus"));
    expect(result.current.pendingModel).toBe("haiku");
    expect(result.current.unsent).toBe(true);
  });

  it("markSent on no pick is a no-op, not a phantom pick", () => {
    const { result } = renderHook(() => useModelPick("sonnet"));
    act(() => result.current.markSent(undefined));
    expect(result.current.pendingModel).toBeUndefined();
    expect(result.current.unsent).toBe(false);
  });

  it("reset drops the pick when the conversation changes", () => {
    const { result } = renderHook(() => useModelPick(null));
    act(() => result.current.select("opus"));
    act(() => result.current.reset());
    expect(result.current.pendingModel).toBeUndefined();
  });
});
