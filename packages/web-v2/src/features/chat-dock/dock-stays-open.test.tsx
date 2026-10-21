// REQ-11 r4 BC-8 (owner 2026-10-21): once opened, the dock stays open across every page and action in
// the app, and across a reload, until the person closes it. The phone's slide-over: chat-dock-phone.test.tsx.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatDockState } from "./dock";

const nav = vi.hoisted(() => ({ path: "/projects/forge/requirements" }));
vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ usePathname: () => nav.path }));

afterEach(() => {
  window.localStorage.clear();
  nav.path = "/projects/forge/requirements";
});

function openDock() {
  const hook = renderHook(() => useChatDockState("p1"));
  act(() => hook.result.current.show());
  expect(hook.result.current.open).toBe(true);
  return hook;
}

const go = (hook: { rerender: () => void }, to: string) => {
  nav.path = to;
  hook.rerender();
};

describe("the dock across the app", () => {
  it("stays open on every page it is taken to, by a link, a menu or Back", () => {
    const hook = openDock();
    go(hook, "/projects/forge/requirements/REQ-43");
    expect(hook.result.current.open).toBe(true);
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    go(hook, "/projects/forge/releases");
    expect(hook.result.current.open).toBe(true);
  });

  it("stays open after a reload, and stays closed after one once closed", () => {
    openDock().unmount();
    const reloaded = renderHook(() => useChatDockState("p1"));
    expect(reloaded.result.current.open).toBe(true);
    act(() => reloaded.result.current.close());
    reloaded.unmount();
    nav.path = "/projects/forge";
    expect(renderHook(() => useChatDockState("p1")).result.current.open).toBe(false);
  });
});
