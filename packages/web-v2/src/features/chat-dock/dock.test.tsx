// REQ-31 BC-5 (ISS-493): the size a person last chose is kept in that browser, and a width saved
// before the two sizes shipped moves once to large, on the first open and never on a later one.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatDockState } from "./dock";
import { DOCK_SIZE_KEY, LEGACY_DOCK_WIDTH_KEY } from "./dock-size";

vi.mock("next/navigation", () => ({ usePathname: () => "/projects/forge/issues" }));

afterEach(() => window.localStorage.clear());

const open = () => renderHook(() => useChatDockState("p1"));

describe("the size a browser keeps", () => {
  it("moves a width saved before this change to large on the first open", async () => {
    window.localStorage.setItem(LEGACY_DOCK_WIDTH_KEY, "650");
    const { result } = open();
    await waitFor(() => expect(window.localStorage.getItem(DOCK_SIZE_KEY)).toBe('"large"'));
    expect(result.current.size).toBe("large");
    expect(window.localStorage.getItem(LEGACY_DOCK_WIDTH_KEY)).toBeNull();
  });

  it("keeps the size chosen after that on the second open, and does not move it again", async () => {
    window.localStorage.setItem(LEGACY_DOCK_WIDTH_KEY, "650");
    const first = open();
    await waitFor(() => expect(window.localStorage.getItem(DOCK_SIZE_KEY)).toBe('"large"'));
    act(() => first.result.current.setSize("half"));
    first.unmount();
    // a tab still on the old build writes the old key after the move
    window.localStorage.setItem(LEGACY_DOCK_WIDTH_KEY, "420");

    const second = open();
    await waitFor(() => expect(second.result.current.size).toBe("half"));
    await new Promise((r) => setTimeout(r, 20));
    expect(second.result.current.size).toBe("half");
    expect(window.localStorage.getItem(DOCK_SIZE_KEY)).toBe('"half"');
  });

  it("keeps a dragged width as the px it was dragged to", async () => {
    const first = open();
    await waitFor(() => expect(window.localStorage.getItem(DOCK_SIZE_KEY)).toBe('"large"'));
    act(() => first.result.current.setSize(512));
    first.unmount();
    const second = open();
    await waitFor(() => expect(second.result.current.size).toBe(512));
  });
});
