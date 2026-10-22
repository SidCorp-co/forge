// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { pushLocationSearch, replaceLocationSearch, useLocationSearch } from "./use-location-search";

const nativeReplace = window.history.replaceState;
const nativePush = window.history.pushState;

describe("useLocationSearch (ISS-1334)", () => {
  afterEach(() => {
    window.history.replaceState = nativeReplace;
    window.history.pushState = nativePush;
    nativeReplace.call(window.history, null, "", "/");
  });

  it("hears a write made through replaceLocationSearch", () => {
    const { result } = renderHook(() => useLocationSearch());

    act(() => replaceLocationSearch("/issues?q=ISS-1280"));

    expect(result.current).toBe("?q=ISS-1280");
  });

  it("still hears it after another patcher puts back the history method it captured", () => {
    const { result } = renderHook(() => useLocationSearch());
    // What Next's AppRouter and route-progress do on effect cleanup: restore the method they saw.
    window.history.replaceState = nativeReplace;

    act(() => replaceLocationSearch("/issues?q=1280"));

    expect(result.current).toBe("?q=1280");
  });

  it("hears a push made through pushLocationSearch after the patch is put back, and keeps the entry it left", () => {
    const { result } = renderHook(() => useLocationSearch());
    window.history.pushState = nativePush;
    const entries = window.history.length;

    act(() => pushLocationSearch("/projects/desk/settings?tab=integrations&field=verify-probe"));

    expect(result.current).toBe("?tab=integrations&field=verify-probe");
    expect(window.history.length).toBe(entries + 1);
  });
});
