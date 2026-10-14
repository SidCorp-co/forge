// @vitest-environment jsdom
//
// ISS-1264 — a list that draws only the rows in view. jsdom has no layout, so each test names the
// sizes it is asserting wiring for (a 600px frame, 80px rows) and never a coordinate: which rows are
// drawn, what each says about its place, where focus goes, and when more is asked for. How it looks
// at 390px and 1280px is the browser walk's.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLayout } from "@/test-support/layout";
import { VirtualList, type VirtualListMore } from "./virtual-list";

expect.extend(matchers);

const FRAME = 600;
const ROW = 80;
let restore: () => void;

beforeEach(() => {
  restore = stubLayout((el) => {
    if (el.firstElementChild?.getAttribute("role") === "feed") return { width: 400, height: FRAME };
    if (el.tagName === "ARTICLE") return { width: 400, height: ROW };
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  restore();
});

interface Item {
  id: string;
  title: string;
}
const items = (n: number): Item[] => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, title: `Row ${i + 1}` }));

function list(rows: Item[], extra: Partial<Parameters<typeof VirtualList<Item>>[0]> = {}) {
  return render(
    <VirtualList
      aria-label="Inbox"
      rows={rows}
      getRowId={(r) => r.id}
      renderRow={(r) => <p>{r.title}</p>}
      getRowLabel={(r) => r.title}
      estimateRowHeight={ROW}
      {...extra}
    />,
  );
}

const articles = () => screen.queryAllByRole("article");
const scroller = () => screen.getByRole("feed").parentElement as HTMLElement;
const indexes = () => articles().map((a) => Number(a.dataset.index));

async function scrollTo(top: number) {
  await act(async () => {
    scroller().scrollTop = top;
    fireEvent.scroll(scroller());
  });
}

describe("the rows it draws", () => {
  it("puts a few dozen of 1,300 rows in the document, from the first", async () => {
    list(items(1300), { totalCount: 1300 });
    await act(async () => {});
    expect(articles().length).toBeGreaterThan(5);
    expect(articles().length).toBeLessThan(40);
    expect(indexes()[0]).toBe(0);
  });

  it("moves the window when the frame scrolls, and lets go of what it left", async () => {
    list(items(1300));
    await act(async () => {});
    await scrollTo(ROW * 500);
    expect(indexes()).toContain(500);
    expect(indexes()).not.toContain(0);
    expect(articles().length).toBeLessThan(40);
  });

  it("draws exactly one row for a list of one, and nothing after it", async () => {
    list(items(1));
    await act(async () => {});
    expect(articles()).toHaveLength(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("draws what `empty` says, and no feed, for a list of none", () => {
    list([], { empty: <p>All caught up</p> });
    expect(screen.getByText("All caught up")).toBeInTheDocument();
    expect(screen.queryByRole("feed")).toBeNull();
  });

  it("draws nothing at all for a list of none with no `empty`", () => {
    const { container } = list([]);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("what a screen reader is told", () => {
  it("names the feed and gives each row its place in the whole, loaded or not", async () => {
    list(items(25), { totalCount: 1300 });
    await act(async () => {});
    expect(screen.getByRole("feed", { name: "Inbox" })).toBeInTheDocument();
    const first = articles()[0] as HTMLElement;
    expect(first).toHaveAttribute("aria-posinset", "1");
    expect(first).toHaveAttribute("aria-setsize", "1300");
    expect(first).toHaveAccessibleName("Row 1");
  });

  it("never reports a whole smaller than what it holds", async () => {
    list(items(25), { totalCount: 3 });
    await act(async () => {});
    expect(articles()[0]).toHaveAttribute("aria-setsize", "25");
  });
});

describe("the keyboard", () => {
  async function opened() {
    list(items(1300));
    await act(async () => {});
    const first = articles()[0] as HTMLElement;
    act(() => first.focus());
    return first;
  }

  it("moves focus to the next row on PageDown and back on PageUp", async () => {
    const first = await opened();
    await act(async () => void fireEvent.keyDown(first, { key: "PageDown" }));
    expect(document.activeElement).toHaveAttribute("data-index", "1");
    await act(async () => void fireEvent.keyDown(document.activeElement as Element, { key: "PageUp" }));
    expect(document.activeElement).toHaveAttribute("data-index", "0");
  });

  it("stays on the first row on PageUp there, and does not scroll the page", async () => {
    const first = await opened();
    const notPrevented = fireEvent.keyDown(first, { key: "PageUp" });
    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe(first);
  });

  it("reaches a row that was not in the document by Ctrl+End, rendered and focusable", async () => {
    const first = await opened();
    expect(indexes()).not.toContain(1299);
    await act(async () => void fireEvent.keyDown(first, { key: "End", ctrlKey: true }));
    expect(indexes()).toContain(1299);
    expect(document.activeElement).toHaveAttribute("data-index", "1299");
    expect(document.activeElement).toHaveAttribute("tabindex", "0");
  });

  it("returns to the first row on Ctrl+Home", async () => {
    const first = await opened();
    await act(async () => void fireEvent.keyDown(first, { key: "End", ctrlKey: true }));
    await act(async () => void fireEvent.keyDown(document.activeElement as Element, { key: "Home", ctrlKey: true }));
    expect(document.activeElement).toHaveAttribute("data-index", "0");
  });

  it("takes a plain End to the last row as Ctrl+End does, since the browser's own End rests short of rows not yet measured", async () => {
    const first = await opened();
    await act(async () => void fireEvent.keyDown(first, { key: "End" }));
    expect(indexes()).toContain(1299);
    expect(document.activeElement).toHaveAttribute("data-index", "1299");
  });

  it("leaves Shift+End to the browser, which selects with it", async () => {
    const first = await opened();
    expect(fireEvent.keyDown(first, { key: "End", shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it("leaves End alone inside a text field in a row", async () => {
    list(items(5), { renderRow: (r) => <input aria-label={`note ${r.id}`} /> });
    await act(async () => {});
    const field = screen.getByLabelText("note n0");
    act(() => field.focus());
    expect(fireEvent.keyDown(field, { key: "End" })).toBe(true);
    expect(document.activeElement).toBe(field);
  });

  it("leaves PageDown alone inside a text field in a row", async () => {
    list(items(5), { renderRow: (r) => <input aria-label={`note ${r.id}`} /> });
    await act(async () => {});
    const field = screen.getByLabelText("note n0");
    act(() => field.focus());
    expect(fireEvent.keyDown(field, { key: "PageDown" })).toBe(true);
    expect(document.activeElement).toBe(field);
  });

  it("keeps the row that holds focus in the document when it is scrolled far out of view", async () => {
    const first = await opened();
    await scrollTo(ROW * 700);
    expect(indexes()).not.toContain(1);
    expect(indexes()).toContain(0);
    expect(first.isConnected).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it("keeps the same row, not the same place, when rows arrive above it", async () => {
    const view = list(items(1300));
    await act(async () => {});
    const first = articles()[0] as HTMLElement;
    act(() => first.focus());
    await scrollTo(ROW * 700);
    const arrived = [{ id: "new", title: "Newest" }, ...items(1300)];
    view.rerender(
      <VirtualList aria-label="Inbox" rows={arrived} getRowId={(r) => r.id} renderRow={(r) => <p>{r.title}</p>} getRowLabel={(r) => r.title} estimateRowHeight={ROW} />,
    );
    await act(async () => {});
    expect(first.isConnected).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(first).toHaveAttribute("data-index", "1");
    expect(indexes()).not.toContain(2);
  });

  it("lets the row go once focus has left the list", async () => {
    const first = await opened();
    act(() => first.blur());
    await scrollTo(ROW * 700);
    expect(indexes()).not.toContain(0);
  });
});

describe("loading more", () => {
  function more(over: Partial<VirtualListMore> = {}): VirtualListMore {
    return { onLoad: vi.fn(), loading: false, failed: false, ...over };
  }

  it("does not ask while the end is out of view", async () => {
    const m = more();
    list(items(100), { more: m });
    await act(async () => {});
    expect(m.onLoad).not.toHaveBeenCalled();
  });

  it("asks once as the end of what is loaded comes into view", async () => {
    const m = more();
    list(items(100), { more: m });
    await act(async () => {});
    await scrollTo(ROW * 100);
    expect(m.onLoad).toHaveBeenCalledTimes(1);
  });

  it("says it is loading, marks the feed busy, and does not ask again meanwhile", async () => {
    const m = more({ loading: true });
    list(items(100), { more: m });
    await act(async () => {});
    await scrollTo(ROW * 100);
    expect(m.onLoad).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Loading more…");
    expect(screen.getByRole("feed")).toHaveAttribute("aria-busy", "true");
  });

  it("does not mistake the row kept for focus at the end for the end being in view", async () => {
    const m = more({ loading: true });
    const view = list(items(100), { more: m });
    await act(async () => {});
    await scrollTo(ROW * 100);
    act(() => (articles().at(-1) as HTMLElement).focus());
    await scrollTo(0);
    expect(indexes()).toContain(99);
    const idle = more();
    view.rerender(
      <VirtualList aria-label="Inbox" rows={items(100)} getRowId={(r) => r.id} renderRow={(r) => <p>{r.title}</p>} estimateRowHeight={ROW} more={idle} />,
    );
    await act(async () => {});
    expect(idle.onLoad).not.toHaveBeenCalled();
  });

  it("asks for a short list at once, since its end is already in view", async () => {
    const m = more();
    list(items(4), { more: m });
    await act(async () => {});
    expect(m.onLoad).toHaveBeenCalledTimes(1);
  });

  it("says a load failed, asks nothing by itself, and asks once more on Retry", async () => {
    const m = more({ failed: true });
    const view = list(items(4), { more: m });
    await act(async () => {});
    await scrollTo(0);
    view.rerender(
      <VirtualList aria-label="Inbox" rows={items(4)} getRowId={(r) => r.id} renderRow={(r) => <p>{r.title}</p>} more={m} estimateRowHeight={ROW} />,
    );
    expect(m.onLoad).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't load more.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(m.onLoad).toHaveBeenCalledTimes(1);
  });

  it("shows no status at all once everything is loaded", async () => {
    list(items(4));
    await act(async () => {});
    expect(screen.queryByRole("status")).toBeNull();
  });
});
