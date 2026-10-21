// A link or action taken inside the docked chat carries the dock to the page it opens (owner
// 2026-10-21); a click anywhere else, or a browser Back, still finds the new page with it closed
// (REQ-11 BC-8), and a pinned dock stays open either way.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCK_CARRIES_ATTR, useChatDockState } from "./dock";

const nav = vi.hoisted(() => ({ path: "/projects/forge/requirements" }));
vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ usePathname: () => nav.path }));

afterEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = "";
  nav.path = "/projects/forge/requirements";
});

function page() {
  const panel = document.createElement("aside");
  panel.setAttribute(DOCK_CARRIES_ATTR, "");
  const link = document.createElement("a");
  panel.append(link);
  const menu = document.createElement("a");
  document.body.append(panel, menu);
  return { link, menu };
}

function openDock() {
  const hook = renderHook(() => useChatDockState("p1"));
  act(() => hook.result.current.show());
  expect(hook.result.current.open).toBe(true);
  return hook;
}

const go = (hook: ReturnType<typeof openDock>, to: string) => {
  nav.path = to;
  hook.rerender();
};

describe("the dock across a page change", () => {
  it("stays open on the page a link inside it opened, and stays there on the next render", () => {
    const { link } = page();
    const hook = openDock();
    act(() => link.click());
    go(hook, "/projects/forge/requirements/REQ-43");
    expect(hook.result.current.open).toBe(true);
    hook.rerender();
    expect(hook.result.current.open).toBe(true);
  });

  it("closes on a page reached from a click outside it, even after a click inside it", () => {
    const { link, menu } = page();
    const hook = openDock();
    act(() => link.click());
    act(() => menu.click());
    go(hook, "/projects/forge/releases");
    expect(hook.result.current.open).toBe(false);
  });

  it("closes on a page reached by Back after a click inside it", () => {
    const { link } = page();
    const hook = openDock();
    act(() => link.click());
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    go(hook, "/projects/forge");
    expect(hook.result.current.open).toBe(false);
  });

  it("stays open on any page while pinned", () => {
    const { menu } = page();
    const hook = openDock();
    act(() => hook.result.current.setPinned(true));
    act(() => menu.click());
    go(hook, "/projects/forge/releases");
    expect(hook.result.current.open).toBe(true);
  });
});
