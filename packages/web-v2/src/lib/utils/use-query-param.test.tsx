// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useQueryParam } from "./use-query-param";
import { useTabParam } from "./use-tab-param";

vi.mock("next/navigation", () => ({ usePathname: () => "/projects/hop/releases" }));

const native = History.prototype.replaceState;

// What Next's app router does once mounted: put back a replaceState of its own over whatever was
// installed, so a wrapper installed by useLocationSearch never sees the write.
function overwriteLikeNext() {
  window.history.replaceState = function (this: History, ...args: Parameters<History["replaceState"]>) {
    return native.apply(this, args);
  };
}

afterEach(() => {
  native.call(window.history, null, "", "/projects/hop/releases");
});

describe("a query-string writer re-renders its readers even when history.replaceState is not ours", () => {
  it("useQueryParam reads back what it wrote", () => {
    const { result } = renderHook(() => useQueryParam("v"));
    overwriteLikeNext();
    expect(result.current[0]).toBeNull();
    act(() => result.current[1]("hop-rc2"));
    expect(window.location.search).toBe("?v=hop-rc2");
    expect(result.current[0]).toBe("hop-rc2");
    act(() => result.current[1](null));
    expect(result.current[0]).toBeNull();
  });

  it("useTabParam reads back what it wrote", () => {
    const { result } = renderHook(() => useTabParam(["list", "board"] as const, "list"));
    overwriteLikeNext();
    act(() => result.current[1]("board"));
    expect(result.current[0]).toBe("board");
  });
});
