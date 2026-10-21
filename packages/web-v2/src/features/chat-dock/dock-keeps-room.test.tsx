// Owner 2026-10-21: reloading the page with a conversation open opened a different one. The room a
// person opens, or a draft that becomes one, is kept in that browser per project and offered back.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatDockState } from "./dock";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ usePathname: () => "/projects/forge" }));

afterEach(() => window.localStorage.clear());

const mount = (projectId: string) => renderHook(() => useChatDockState(projectId));

describe("the room a browser keeps across a reload", () => {
  it("offers back the room picked before the reload", () => {
    const before = mount("p1");
    expect(before.result.current.keptRoom).toBeNull();
    act(() => before.result.current.select({ kind: "room", projectId: "p1", conversationId: "c7" }));
    before.unmount();

    const after = mount("p1");
    expect(after.result.current.target).toEqual({ kind: "latest", projectId: "p1" });
    expect(after.result.current.keptRoom).toBe("c7");
  });

  it("keeps the room a new chat became once its first message made it one", () => {
    const before = mount("p1");
    act(() => before.result.current.select({ kind: "draft", projectId: "p1" }));
    act(() => before.result.current.follow("c9"));
    before.unmount();
    expect(mount("p1").result.current.keptRoom).toBe("c9");
  });

  it("keeps one room per project, so another project opens its own", () => {
    const one = mount("p1");
    act(() => one.result.current.select({ kind: "room", projectId: "p1", conversationId: "c1" }));
    one.unmount();
    const two = mount("p2");
    expect(two.result.current.keptRoom).toBeNull();
    act(() => two.result.current.select({ kind: "room", projectId: "p2", conversationId: "c2" }));
    two.unmount();
    expect(mount("p1").result.current.keptRoom).toBe("c1");
    expect(mount("p2").result.current.keptRoom).toBe("c2");
  });
});
