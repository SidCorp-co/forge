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

describe("the dock across a fresh page load", () => {
  it("never draws it, not for one frame, on another page when it was left open, unpinned, elsewhere", () => {
    window.localStorage.setItem("web-v2:chat-dock-open-on", JSON.stringify("/projects/hop/issues"));
    const frames: boolean[] = [];
    renderHook(() => {
      const dock = useChatDockState("p1");
      frames.push(dock.open);
      return dock;
    });
    expect(frames.length).toBeGreaterThan(1);
    expect(frames).not.toContain(true);
  });

  it("finds it open again on the page it was left open on", () => {
    window.localStorage.setItem("web-v2:chat-dock-open-on", JSON.stringify("/projects/hop/requirements/REQ-1"));
    const { result } = renderHook(() => useChatDockState("p1"));
    expect(result.current.open).toBe(true);
  });

  it("finds it open on any page once pinned", () => {
    window.localStorage.setItem("web-v2:chat-dock-open-on", JSON.stringify("/projects/hop/issues"));
    window.localStorage.setItem(DOCK_PINNED_KEY, "true");
    const { result } = renderHook(() => useChatDockState("p1"));
    expect(result.current.open).toBe(true);
  });

  it("stays closed when the person comes back to the page it was closed away from", () => {
    const { result, rerender } = renderHook(() => useChatDockState("p1"));
    act(() => result.current.show());
    nav.pathname = "/projects/hop/issues";
    rerender();
    nav.pathname = "/projects/hop/requirements/REQ-1";
    rerender();
    expect(result.current.open).toBe(false);
  });

  it("keeps it open where the person is when they unpin it on another page", () => {
    const { result, rerender } = renderHook(() => useChatDockState("p1"));
    act(() => {
      result.current.setPinned(true);
      result.current.show();
    });
    nav.pathname = "/projects/hop/issues";
    rerender();
    act(() => result.current.setPinned(false));
    expect(result.current.open).toBe(true);
  });
});
