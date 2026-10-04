// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/projects/hop/requirements/REQ-1" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const { DOCK_PINNED_KEY, useChatDockState } = await import("./dock");

beforeEach(() => {
  window.localStorage.clear();
  nav.pathname = "/projects/hop/requirements/REQ-1";
});

describe("the dock across navigation", () => {
  it("closes when the person moves to another page and it is not pinned", () => {
    const { result, rerender } = renderHook(() => useChatDockState("p1"));
    act(() => result.current.show());
    expect(result.current.open).toBe(true);
    nav.pathname = "/projects/hop/issues";
    rerender();
    expect(result.current.open).toBe(false);
  });

  it("stays open across pages once pinned, and remembers the pin", () => {
    const { result, rerender } = renderHook(() => useChatDockState("p1"));
    act(() => {
      result.current.setPinned(true);
      result.current.show();
    });
    nav.pathname = "/projects/hop/issues";
    rerender();
    expect(result.current.open).toBe(true);
    expect(window.localStorage.getItem(DOCK_PINNED_KEY)).toBe("true");
  });

  it("keeps open on the same page, whatever else re-renders it", () => {
    const { result, rerender } = renderHook(() => useChatDockState("p1"));
    act(() => result.current.show());
    rerender();
    expect(result.current.open).toBe(true);
  });
});
