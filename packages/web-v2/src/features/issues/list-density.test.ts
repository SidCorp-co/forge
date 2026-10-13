// @vitest-environment jsdom
//
// ISS-1155 — the Issues list's density: Compact by default, the viewer's choice kept in the browser,
// and a stored value that is neither density read as the default rather than as a third density.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DENSITY, densityOf, LIST_DENSITY_KEY, useListDensity } from "./list-density";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("densityOf", () => {
  it("is Compact by default", () => {
    expect(DEFAULT_DENSITY).toBe("compact");
  });

  it("keeps the two densities", () => {
    expect(densityOf("compact")).toBe("compact");
    expect(densityOf("comfortable")).toBe("comfortable");
  });

  it.each([["roomy"], [""], [null], [undefined], [3], [{ density: "comfortable" }]])(
    "reads %j as the default, not as a density of its own",
    (stored) => {
      expect(densityOf(stored)).toBe(DEFAULT_DENSITY);
    },
  );
});

describe("useListDensity", () => {
  it("starts on Compact with nothing stored", () => {
    const { result } = renderHook(() => useListDensity());
    expect(result.current[0]).toBe("compact");
  });

  it("keeps the choice in the browser and restores it on the next mount", () => {
    const first = renderHook(() => useListDensity());
    act(() => first.result.current[1]("comfortable"));
    expect(first.result.current[0]).toBe("comfortable");
    expect(JSON.parse(window.localStorage.getItem(LIST_DENSITY_KEY) ?? "null")).toBe("comfortable");
    first.unmount();

    const second = renderHook(() => useListDensity());
    expect(second.result.current[0]).toBe("comfortable");
  });

  it("reads a corrupt stored value as Compact", () => {
    window.localStorage.setItem(LIST_DENSITY_KEY, JSON.stringify("spacious"));
    const { result } = renderHook(() => useListDensity());
    expect(result.current[0]).toBe("compact");
  });
});
