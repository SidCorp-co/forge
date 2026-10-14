// @vitest-environment jsdom
//
// ISS-1264 — a runtime with no `matchMedia` (jsdom, an embedded view) is a runtime where no query
// matches, as `forge-mascot` and `use-animated-number` already read it, and not one that throws.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMediaQuery } from "./use-media-query";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useMediaQuery", () => {
  it("is false, and does not throw, where the runtime has no matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(renderHook(() => useMediaQuery("(min-width: 40rem)")).result.current).toBe(false);
  });

  it("reads the query once mounted and follows it when it changes", () => {
    let listener: ((event: MediaQueryListEvent) => void) | undefined;
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: (_: string, fn: typeof listener) => (listener = fn),
      removeEventListener: () => {},
    }));
    const { result } = renderHook(() => useMediaQuery("(min-width: 40rem)"));
    expect(result.current).toBe(true);
    act(() => listener?.({ matches: false } as MediaQueryListEvent));
    expect(result.current).toBe(false);
  });
});
