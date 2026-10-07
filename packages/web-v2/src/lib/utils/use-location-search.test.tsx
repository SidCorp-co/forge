// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { replaceLocationSearch, useLocationSearch } from "./use-location-search";

const nativeReplace = window.history.replaceState;

describe("useLocationSearch (ISS-1334)", () => {
  afterEach(() => {
    window.history.replaceState = nativeReplace;
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
});
