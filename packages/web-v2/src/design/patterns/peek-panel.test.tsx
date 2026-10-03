// @vitest-environment jsdom
//
// The peek is URL state: `?peek=` names the open row, written without stacking history, moved
// through the visible rows, closed by Esc.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PeekPanel, usePeek, usePeekKeys } from "./peek-panel";

expect.extend(matchers);
afterEach(cleanup);
beforeEach(() => window.history.replaceState(null, "", "/list?group=module"));

const KEYS = ["A-1", "A-2", "A-3"];

describe("usePeek", () => {
  it("opens a row into ?peek= and keeps the other params", () => {
    const before = window.history.length;
    const { result } = renderHook(() => usePeek(KEYS));
    expect(result.current.open).toBeNull();
    act(() => result.current.set("A-2"));
    expect(window.location.search).toBe("?group=module&peek=A-2");
    expect(window.history.length).toBe(before);
    expect(result.current.position).toEqual({ at: 2, of: 3 });
  });

  it("moves by the visible order and stops at the ends", () => {
    window.history.replaceState(null, "", "/list?peek=A-3");
    const { result } = renderHook(() => usePeek(KEYS));
    act(() => result.current.move(1));
    expect(result.current.open).toBe("A-3");
    act(() => result.current.move(-1));
    expect(result.current.open).toBe("A-2");
  });

  it("reads a key that is not in the list as closed", () => {
    window.history.replaceState(null, "", "/list?peek=ZZ-9");
    const { result } = renderHook(() => usePeek(KEYS));
    expect(result.current.open).toBeNull();
  });
});

function Harness() {
  const peek = usePeek(KEYS);
  usePeekKeys(peek, () => {});
  return peek.open ? (
    <PeekPanel peek={peek} listLabel="Issues" noun="Issue" onOpenFull={() => {}}>
      <p>{peek.open}</p>
    </PeekPanel>
  ) : null;
}

describe("PeekPanel", () => {
  it("shows its place in the list and closes on Esc", () => {
    window.history.replaceState(null, "", "/list?peek=A-1");
    render(<Harness />);
    expect(screen.getByTestId("peek-position")).toHaveTextContent("1 of 3");
    fireEvent.keyDown(window, { key: "j" });
    expect(screen.getByTestId("peek-position")).toHaveTextContent("2 of 3");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("peek-panel")).toBeNull();
    expect(window.location.search).toBe("");
  });
});
