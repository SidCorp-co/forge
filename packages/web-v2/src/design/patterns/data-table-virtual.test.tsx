// @vitest-environment jsdom
//
// ISS-1264: a table of more than 100 rows draws only the rows in view, inside a frame of its own, and
// says to a screen reader how many rows it holds and which each drawn one is. jsdom has no layout, so
// each test names the sizes it is asserting wiring for (a 560px frame, 56px rows) and never a
// coordinate; the sticky column and the reach of a row action at 390px and 1280px are measured in a
// real Chrome by `sticky-reach.test.tsx`.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubLayout } from "@/test-support/layout";
import { DataTable, type DataTableColumn, VIRTUALIZE_ABOVE } from "./data-table";

expect.extend(matchers);

const FRAME = 560;
const ROW = 56;
let restore: () => void;

beforeEach(() => {
  restore = stubLayout((el) => {
    if (el.firstElementChild?.tagName === "TABLE") return { width: 800, height: FRAME };
    if (el.tagName === "TR" && el.hasAttribute("data-index")) return { width: 800, height: ROW };
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  restore();
});

interface Row {
  id: string;
  name: string;
}
const rowsOf = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `name ${String(i).padStart(4, "0")}` }));

const COLUMNS: DataTableColumn<Row>[] = [
  { id: "name", header: "Name", sticky: true, cell: (r) => r.name, sortValue: (r) => r.name },
  {
    id: "actions",
    header: null,
    headerLabel: "Actions",
    cell: (r) => <button type="button">{`Open ${r.id}`}</button>,
  },
];

function table(n: number, extra: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) {
  return render(<DataTable rows={rowsOf(n)} columns={COLUMNS} getRowId={(r) => r.id} aria-label="Things" {...extra} />);
}

const bodyRows = () => Array.from(document.querySelectorAll<HTMLElement>("tbody tr[data-index]"));
const indexes = () => bodyRows().map((r) => Number(r.dataset.index));
const scroller = () => screen.getByRole("table").parentElement as HTMLElement;

async function scrollTo(top: number) {
  await act(async () => {
    scroller().scrollTop = top;
    fireEvent.scroll(scroller());
  });
}

describe("a table of 100 rows or fewer", () => {
  it("draws every row, as it did, with no frame of its own and no row numbers", () => {
    table(VIRTUALIZE_ABOVE);
    expect(screen.getAllByRole("row")).toHaveLength(VIRTUALIZE_ABOVE + 1);
    expect(screen.getByRole("table")).not.toHaveAttribute("aria-rowcount");
    expect(document.querySelector("[aria-rowindex]")).toBeNull();
    expect(scroller().className).not.toContain("overflow-y-auto");
  });
});

describe("a table of more than 100 rows", () => {
  it("draws a few dozen rows, from the first, and not all 101", async () => {
    table(VIRTUALIZE_ABOVE + 1);
    await act(async () => {});
    expect(bodyRows().length).toBeGreaterThan(5);
    expect(bodyRows().length).toBeLessThan(40);
    expect(indexes()[0]).toBe(0);
  });

  it("reports every row, the header's place and each drawn row's", async () => {
    table(300);
    await act(async () => {});
    expect(screen.getByRole("table")).toHaveAttribute("aria-rowcount", "301");
    expect(screen.getAllByRole("row")[0]).toHaveAttribute("aria-rowindex", "1");
    expect(bodyRows()[0]).toHaveAttribute("aria-rowindex", "2");
    expect(bodyRows()[3]).toHaveAttribute("aria-rowindex", "5");
  });

  it("scrolls inside a named frame that a keyboard can enter, with the header kept in view", async () => {
    table(300);
    await act(async () => {});
    expect(screen.getByRole("region", { name: "Things" })).toBe(scroller());
    expect(scroller()).toHaveAttribute("tabindex", "0");
    expect(scroller().className).toContain("overflow-y-auto");
    expect(document.querySelector("thead")?.className).toContain("[&_th]:sticky");
  });

  it("moves the window with the scroll, and the rows it does not draw still take up their height", async () => {
    table(300);
    await act(async () => {});
    await scrollTo(ROW * 200);
    expect(indexes()).toContain(200);
    expect(indexes()).not.toContain(0);
    const spacers = Array.from(document.querySelectorAll<HTMLElement>("tbody tr[aria-hidden] td"));
    const unseen = spacers.reduce((sum, td) => sum + Number.parseFloat(td.style.height), 0);
    expect(unseen + bodyRows().length * ROW).toBe(300 * ROW);
  });

  it("orders the rows it holds when a header is pressed, not only the ones drawn", async () => {
    table(300, { defaultSort: { id: "name", desc: false } });
    await act(async () => {});
    expect(within(bodyRows()[0] as HTMLElement).getByText("name 0000")).toBeInTheDocument();
    await act(async () => void fireEvent.click(within(screen.getByRole("columnheader", { name: /Name/ })).getByRole("button")));
    expect(within(bodyRows()[0] as HTMLElement).getByText("name 0299")).toBeInTheDocument();
  });

  it("windows at the threshold a screen sets", async () => {
    table(6, { virtualizeAbove: 5 });
    await act(async () => {});
    expect(screen.getByRole("table")).toHaveAttribute("aria-rowcount", "7");
  });

  it("keeps the first column sticky and every row's action in its own cell", async () => {
    table(300);
    await act(async () => {});
    for (const row of bodyRows()) {
      const cells = within(row).getAllByRole("cell");
      expect(cells[0]?.className).toContain("sticky");
      expect(within(cells[1] as HTMLElement).getByRole("button")).toBeInTheDocument();
    }
  });
});

describe("a table of more than 100 rows, by keyboard", () => {
  it("reaches an action that was not drawn when the table opened, once focus has scrolled it near", async () => {
    table(300);
    await act(async () => {});
    const drawn = indexes();
    const last = drawn[drawn.length - 1] as number;
    expect(screen.queryByRole("button", { name: `Open r${last + 40}` })).toBeNull();

    act(() => screen.getByRole("button", { name: `Open r${last}` }).focus());
    await scrollTo(ROW * (last - 2));
    const beyond = screen.getByRole("button", { name: `Open r${last + 1}` });
    act(() => beyond.focus());
    expect(document.activeElement).toBe(beyond);
  });

  it("keeps the row that holds focus drawn when it is scrolled far out of view", async () => {
    table(300);
    await act(async () => {});
    const button = screen.getByRole("button", { name: "Open r2" });
    act(() => button.focus());
    await scrollTo(ROW * 250);
    expect(indexes()).not.toContain(3);
    expect(button.isConnected).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it("lets the row go once focus has left the table", async () => {
    table(300);
    await act(async () => {});
    const button = screen.getByRole("button", { name: "Open r2" });
    act(() => button.focus());
    act(() => button.blur());
    await scrollTo(ROW * 250);
    expect(indexes()).not.toContain(2);
  });
});
