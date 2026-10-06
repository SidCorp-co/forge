// The peek is URL state: `?peek=` names the open row, written without stacking history, moved
// through the visible rows, closed by Esc.

import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PeekPanel, usePeek, usePeekKeys } from "./peek-panel";

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

function Harness({ onOpenFull = () => {} }: { onOpenFull?: (key: string) => void }) {
  const peek = usePeek(KEYS);
  usePeekKeys(peek, onOpenFull);
  return (
    <>
      <input aria-label="filter" />
      {peek.open ? (
        <PeekPanel peek={peek} listLabel="Issues" noun="Issue" onOpenFull={() => onOpenFull(peek.open as string)}>
          <p>{peek.open}</p>
        </PeekPanel>
      ) : null}
    </>
  );
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

  it("opens the full page on Enter, and its buttons step through the rows", () => {
    window.history.replaceState(null, "", "/list?peek=A-1");
    const onOpenFull = vi.fn();
    render(<Harness onOpenFull={onOpenFull} />);
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(onOpenFull).toHaveBeenCalledWith("A-1");
    expect(screen.getByRole("button", { name: "Previous issue (k)" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next issue (j)" }));
    expect(screen.getByTestId("peek-position")).toHaveTextContent("2 of 3");
    expect(window.location.search).toBe("?peek=A-2");
  });

  it("leaves j, k and Escape to a field being typed in", () => {
    window.history.replaceState(null, "", "/list?peek=A-1");
    render(<Harness />);
    const field = screen.getByRole("textbox", { name: "filter" });
    fireEvent.keyDown(field, { key: "j" });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.getByTestId("peek-position")).toHaveTextContent("1 of 3");
  });

  it("does not move on a chorded key", () => {
    window.history.replaceState(null, "", "/list?peek=A-1");
    render(<Harness />);
    fireEvent.keyDown(window, { key: "j", metaKey: true });
    expect(screen.getByTestId("peek-position")).toHaveTextContent("1 of 3");
  });
});
