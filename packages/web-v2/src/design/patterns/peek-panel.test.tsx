// The peek is URL state: `?peek=` names the open row, written without stacking history, moved
// through the visible rows, closed by Esc. Its full page is a link, from the button and the title,
// loaded ahead as the peek opens, and Enter opens it from the list row a click left focused.

import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeekExcerpt, PeekHead, PeekPanel, usePeek, usePeekKeys } from "./peek-panel";

const push = vi.fn();
const preload = vi.fn();
vi.mock("@/lib/navigation/router", async () =>
  (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push }), usePreload: () => preload }),
);

beforeEach(() => {
  window.history.replaceState(null, "", "/list?group=module");
  window.sessionStorage.clear();
  push.mockReset();
  preload.mockReset();
});

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
      {KEYS.map((k) => (
        <a key={k} href={`/list/${k}`} data-testid="list-row" onClick={(e) => (e.preventDefault(), peek.set(k === peek.open ? null : k))}>
          {k}
        </a>
      ))}
      {peek.open ? (
        <PeekPanel peek={peek} listLabel="Issues" noun="Issue" full={{ href: `/list/${peek.open}`, origin: "issues" }}>
          <PeekHead noun="Issue" itemKey={peek.open} title={`Title of ${peek.open}`} />
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

  it("opens the full page from a link, and leaves a modified click to the browser", () => {
    window.history.replaceState(null, "", "/list?peek=A-2");
    render(<Harness />);
    const button = screen.getByTestId("open-full-page");
    expect(button.tagName).toBe("A");
    expect(button).toHaveAttribute("href", "/list/A-2");
    expect(fireEvent.click(button, { metaKey: true })).toBe(true);
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(push).toHaveBeenCalledWith("/list/A-2");
    expect(window.sessionStorage.getItem("web-v2:list-origin:issues")).toBe("/list?peek=A-2");
  });

  it("makes the title the same link to the full page", () => {
    window.history.replaceState(null, "", "/list?peek=A-3");
    render(<Harness />);
    const title = screen.getByTestId("peek-title-link");
    expect(title).toHaveAttribute("href", "/list/A-3");
    expect(title).toHaveTextContent("Title of A-3");
    fireEvent.click(title);
    expect(push).toHaveBeenCalledWith("/list/A-3");
  });

  it("loads the open row's full page ahead, and the next one's as it moves", () => {
    window.history.replaceState(null, "", "/list?peek=A-1");
    render(<Harness />);
    expect(preload).toHaveBeenLastCalledWith("/list/A-1");
    fireEvent.keyDown(window, { key: "j" });
    expect(preload).toHaveBeenLastCalledWith("/list/A-2");
  });

  it("opens the full page on Enter from the row a click left focused, not the row again", () => {
    window.history.replaceState(null, "", "/list");
    const onOpenFull = vi.fn();
    render(<Harness onOpenFull={onOpenFull} />);
    const row = screen.getByRole("link", { name: "A-1" });
    fireEvent.click(row);
    row.focus();
    expect(screen.getByTestId("peek-position")).toHaveTextContent("1 of 3");
    expect(fireEvent.keyDown(row, { key: "Enter" })).toBe(false);
    expect(onOpenFull).toHaveBeenCalledWith("A-1");
    expect(window.location.search).toBe("?peek=A-1");
  });

  it("refuses a PeekHead drawn outside a peek, which has no full page to link its title to", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<PeekHead noun="Issue" itemKey="A-1" title="Loose" />)).toThrow(/outside a PeekPanel/);
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

describe("PeekExcerpt", () => {
  // jsdom lays nothing out: the text's height and the clamp's are set here, as a browser would measure them
  const measured = (scroll: number, client: number) => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(scroll);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(client);
  };
  afterEach(() => vi.restoreAllMocks());

  it("holds a long text to its clamp and opens the rest in place", () => {
    measured(900, 240);
    render(<PeekExcerpt>long text</PeekExcerpt>);
    const toggle = screen.getByRole("button", { name: "Show all" });
    expect(screen.getByText("long text")).toHaveAttribute("data-clamped", "1");
    expect(screen.getByText("long text")).toHaveClass("max-h-60", "overflow-hidden");
    fireEvent.click(toggle);
    expect(screen.getByText("long text")).not.toHaveAttribute("data-clamped");
    expect(screen.getByText("long text")).not.toHaveClass("max-h-60");
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.getByText("long text")).toHaveAttribute("data-clamped", "1");
  });

  it("shows a text that fits whole and offers nothing", () => {
    measured(120, 120);
    render(<PeekExcerpt>short text</PeekExcerpt>);
    expect(screen.queryByTestId("peek-excerpt-toggle")).toBeNull();
  });
});
