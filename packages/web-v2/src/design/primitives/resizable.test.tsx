// A split keeps the width the reader dragged it to: the list beside its peek unmounts as the peek
// closes, and the next peek opens at that width rather than the default. A width the app sets, not
// the reader, is not kept, and a browser that refuses storage opens the panes at their defaults.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRememberedSplit } from "./resizable";

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

const split = () => renderHook(() => useRememberedSplit("list-peek", ["list", "peek"]));

describe("useRememberedSplit", () => {
  it("opens a fresh browser at the panes' own default sizes", () => {
    expect(split().result.current.defaultLayout).toBeUndefined();
  });

  it("opens the next split at the width the reader dragged the last one to", () => {
    const first = split();
    act(() => first.result.current.onLayoutChanged({ list: 45, peek: 55 }, { isUserInteraction: true }));
    first.unmount();
    expect(split().result.current.defaultLayout).toEqual({ list: 45, peek: 55 });
  });

  it("does not keep a width the app set, only one the reader dragged", () => {
    const first = split();
    act(() => first.result.current.onLayoutChanged({ list: 60, peek: 40 }, { isUserInteraction: false }));
    first.unmount();
    expect(split().result.current.defaultLayout).toBeUndefined();
  });

  it("opens at the defaults, without throwing, where the browser refuses storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const { result } = split();
    expect(result.current.defaultLayout).toBeUndefined();
    expect(() => act(() => result.current.onLayoutChanged({ list: 45, peek: 55 }, { isUserInteraction: true }))).not.toThrow();
  });
});
