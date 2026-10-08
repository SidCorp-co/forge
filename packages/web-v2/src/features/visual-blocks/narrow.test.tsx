// A block stays readable in the narrow chat panel (REQ-32 BC-3, BC-4). What must hold, as structure a
// browser lays out: a table scrolls sideways with its first column held, its text columns keep a
// readable width clamped to two lines with the full text on hover, its figures stay on one line
// right-aligned in tabular digits, and a long table shows its first ten rows with a control for the
// rest; a state cell is the shared badge, its stored value only in the tooltip; the source is one
// short line with the run behind its disclosure; a table, chart, flow or timeline opens wide in the
// shared dialog; a flow scrolls at its own size rather than shrink.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatClock, formatDateTime } from "@/lib/i18n/format";

import { VisualBlockProvider, VisualBlockView } from ".";
import { TABLE_ROW_CAP } from "./table-block";

const AS_OF = "2026-10-08T09:21:44.000Z";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.parse(AS_OF) + 60_000));
  // jsdom lays nothing out: recharts and the flow canvas read a size from these
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ width: 24, height: 12, top: 0, left: 0, right: 24, bottom: 12, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
  );
  vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly cb: ResizeObserverCallback) {}
      observe(target: Element) {
        this.cb([{ target, contentRect: { width: 375, height: 240 } } as unknown as ResizeObserverEntry], this as never);
      }
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// the shape the live answer had: progress-by-requirement, eight columns, thirty-three rows
const fields = [
  { name: "key", type: "ref", label: "Requirement" },
  { name: "title", type: "string", label: "Title" },
  { name: "state", type: "status", label: "State", vocabulary: "requirement" },
  { name: "criteriaProven", type: "number", label: "Criteria proven" },
  { name: "criteriaTotal", type: "number", label: "Criteria" },
  { name: "shipped", type: "number", label: "Issues shipped" },
  { name: "awaitingRelease", type: "number", label: "Issues awaiting release" },
  { name: "toDo", type: "number", label: "Issues to do" },
];
const LONG = "Complaint and service recovery handling (Complaint & Service Recovery) across every ward";
const rows = Array.from({ length: 33 }, (_, i) => ({
  key: `REQ-${i + 1}`,
  title: i === 0 ? LONG : `Requirement ${i + 1}`,
  state: i % 3 === 0 ? "in_delivery" : "agreed",
  criteriaProven: i,
  criteriaTotal: 40,
  shipped: 2,
  awaitingRelease: 1,
  toDo: 12,
}));
const frame = { fields, rows };
const table = {
  v: 1,
  kind: "table",
  title: "Progress by requirement",
  columns: fields.map((f) => f.name),
  source: { runId: "7eadcf98-5a65-44c7-968a-8d080f1ac017" },
  frame,
};
// the table's run, as any other kind of block over the same frame names it
const { columns: _columns, title: _title, ...over } = table;
const facts = { queryId: "progress-by-requirement", asOf: AS_OF };

const show = (block: unknown) =>
  render(
    <VisualBlockProvider value={{ projectSlug: "hop", sourceFacts: () => facts }}>
      <VisualBlockView block={block} />
    </VisualBlockProvider>,
  );

const bodyRows = () => within(screen.getAllByRole("table")[0] as HTMLElement).getAllByRole("row").slice(1);

describe("a table in a narrow container", () => {
  it("scrolls sideways inside its own box and holds its first column while it does", () => {
    show(table);
    expect(screen.getByTestId("table-scroll").className).toContain("overflow-x-auto");
    const head = screen.getAllByRole("columnheader");
    expect(head[0]?.className).toMatch(/\bsticky\b/);
    expect(head[0]?.className).toMatch(/\bleft-0\b/);
    expect(head[0]?.className).toMatch(/\bbg-app\b/);
    const first = within(bodyRows()[0] as HTMLElement).getAllByRole("cell");
    expect(first[0]?.className).toMatch(/\bsticky\b/);
    for (const cell of [...head.slice(1), ...first.slice(1)]) expect(cell.className).not.toMatch(/\bsticky\b/);
  });

  it("keeps a text column at a readable width, clamped to two lines, with the whole text on hover", () => {
    show(table);
    const text = screen.getAllByTestId("table-text")[0] as HTMLElement;
    expect(text.className).toMatch(/\bmin-w-\[10rem\]/);
    expect(text.className).toMatch(/\bline-clamp-2\b/);
    expect(text.getAttribute("title")).toBe(LONG);
    expect(text.textContent).toBe(LONG);
  });

  it("opens a clamped text in place on a tap or a key, for a reader with no pointer to hover", () => {
    show(table);
    const text = screen.getAllByTestId("table-text")[0] as HTMLElement;
    expect(text.tagName).toBe("BUTTON");
    expect(text.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(text);
    expect(text.className).not.toMatch(/\bline-clamp-2\b/);
    expect(text.className).toMatch(/\bmin-w-\[10rem\]/);
    expect(text.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(text);
    expect(text.className).toMatch(/\bline-clamp-2\b/);
  });

  it("puts a figure on one line, right-aligned in tabular digits, and its heading over it", () => {
    show(table);
    const cells = within(bodyRows()[1] as HTMLElement).getAllByRole("cell");
    for (const i of [3, 4, 5, 6, 7]) {
      expect(cells[i]?.className).toMatch(/\bwhitespace-nowrap\b/);
      expect(cells[i]?.className).toMatch(/\btext-right\b/);
      expect(cells[i]?.className).toMatch(/\btabular-nums\b/);
    }
    expect(screen.getAllByRole("columnheader")[3]?.className).toMatch(/\btext-right\b/);
    // a key never breaks across lines either
    expect(cells[0]?.className).toMatch(/\bwhitespace-nowrap\b/);
  });

  it(`shows the first ${TABLE_ROW_CAP} rows of a longer table, then all of them on asking`, () => {
    show(table);
    expect(bodyRows()).toHaveLength(TABLE_ROW_CAP);
    const more = screen.getByTestId("table-show-all");
    expect(more.textContent).toBe("Show all 33 rows");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(bodyRows()).toHaveLength(33);
    expect(more.getAttribute("aria-expanded")).toBe("true");
  });

  it(`offers no control for a table of ${TABLE_ROW_CAP} rows or fewer`, () => {
    show({ ...table, frame: { fields, rows: rows.slice(0, TABLE_ROW_CAP) } });
    expect(bodyRows()).toHaveLength(TABLE_ROW_CAP);
    expect(screen.queryByTestId("table-show-all")).toBeNull();
  });

  it("caps the rows the block's own limit kept, and still says what the limit left out", () => {
    show({ ...table, limit: 12 });
    expect(screen.getByTestId("table-show-all").textContent).toBe("Show all 12 rows");
    expect(screen.getByText("Showing 12 of 33 rows.")).toBeTruthy();
  });
});

describe("a state cell", () => {
  it("is the shared badge in its family's sentence-case label and tone, the stored value only in its tooltip", () => {
    show(table);
    const badges = within(bodyRows()[0] as HTMLElement).getAllByTestId("status-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toContain("In delivery");
    expect(badges[0]?.getAttribute("data-value")).toBe("in_delivery");
    expect(badges[0]?.getAttribute("data-tone")).toBe("run");
    expect(badges[0]?.getAttribute("title")).toMatch(/^in_delivery\b/);
    expect(screen.getAllByRole("table")[0]?.textContent).not.toContain("in_delivery");
    expect(screen.getAllByRole("table")[0]?.textContent).not.toContain("agreed");
  });

  it("reads sentence-cased and neutral where the column names no vocabulary", () => {
    const plain = fields.map((f) => (f.name === "state" ? { name: "state", type: "status", label: "State" } : f));
    show({ ...table, frame: { fields: plain, rows } });
    const badge = within(bodyRows()[0] as HTMLElement).getByTestId("status-badge");
    expect(badge.textContent).toBe("In delivery");
    expect(badge.getAttribute("data-tone")).toBe("neutral");
    expect(badge.getAttribute("title")).toBe("in_delivery");
  });

  it("is the same badge in a status list", () => {
    show({ ...over, kind: "status-list", ref: "key", status: "state" });
    const row = screen.getAllByTestId("status-row")[0] as HTMLElement;
    expect(within(row).getByTestId("status-badge").getAttribute("data-value")).toBe("in_delivery");
    expect(row.textContent).not.toContain("in_delivery");
  });
});

describe("a timeline's lanes", () => {
  it("name a state lane in words, the stored value in the tooltip", () => {
    const lanes = { fields: [{ name: "key", type: "ref", label: "Key" }, { name: "lane", type: "status", label: "Lane" }, { name: "d", type: "date", label: "Day" }], rows: [{ key: "REQ-1", lane: "now", d: "2026-10-01T00:00:00Z" }, { key: "REQ-2", lane: "later", d: "2026-10-09T00:00:00Z" }] };
    show({ ...over, kind: "timeline", label: "key", start: "d", lane: "lane", frame: lanes });
    const heads = screen.getAllByTestId("timeline-lane");
    expect(heads.map((h) => h.textContent)).toEqual(["Now", "Later"]);
    expect(heads.map((h) => h.getAttribute("title"))).toEqual(["now", "later"]);
  });
});

describe("the source line", () => {
  it("reads as the query and a short read time, the run id and the full time behind its disclosure", () => {
    show(table);
    const note = screen.getByTestId("visual-block-source");
    const clock = formatClock(AS_OF, "en");
    expect(note.textContent).toBe(`progress-by-requirement · read ${clock}`);
    expect(note.textContent).not.toContain("7eadcf98");
    const time = note.querySelector("time");
    expect(time?.getAttribute("title")).toBe(formatDateTime(AS_OF, "en"));
    const toggle = screen.getByTestId("visual-block-source-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByTestId("visual-block-source-detail").textContent).toBe(
      `Report run 7eadcf98-5a65-44c7-968a-8d080f1ac017 · read ${formatDateTime(AS_OF, "en")}`,
    );
  });

  it("names the date as well when the read was not today", () => {
    vi.setSystemTime(new Date(Date.parse(AS_OF) + 3 * 86_400_000));
    show(table);
    expect(screen.getByTestId("visual-block-source").textContent).toBe(`progress-by-requirement · read ${formatDateTime(AS_OF, "en")}`);
  });
});

describe("open wide", () => {
  it("shows the same table at full width in the shared dialog", async () => {
    show(table);
    expect(screen.queryByTestId("visual-block-wide")).toBeNull();
    fireEvent.click(screen.getByTestId("visual-block-open-wide"));
    const wide = await screen.findByTestId("visual-block-wide");
    expect(wide.getAttribute("role")).toBe("dialog");
    expect(wide.className).toContain("w-[min(96vw,1200px)]");
    expect(within(wide).getByRole("table")).toBeTruthy();
    expect(within(wide).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(fields.map((f) => f.label));
  });

  it.each(["chart", "flow", "timeline"])("is offered on a %s", (kind) => {
    const blocks: Record<string, unknown> = {
      chart: { ...over, kind: "chart", variant: "bar", x: "key", y: ["toDo"] },
      flow: { v: 1, kind: "flow", nodes: [{ id: "a", label: "A" }], edges: [] },
      timeline: {
        ...over,
        kind: "timeline",
        label: "key",
        start: "d",
        frame: { fields: [{ name: "key", type: "ref", label: "Key" }, { name: "d", type: "date", label: "Day" }], rows: [{ key: "REQ-1", d: "2026-10-01T00:00:00Z" }] },
      },
    };
    show(blocks[kind]);
    expect(screen.getByTestId("visual-block-open-wide")).toBeTruthy();
  });

  it("is not offered on a row of figures, which reads the same at any width", () => {
    show({ ...over, kind: "kpi", figures: [{ field: "toDo", label: "To do" }, { field: "shipped", label: "Shipped" }] });
    expect(screen.getAllByTestId("kpi-figure")).toHaveLength(2);
    expect(screen.queryByTestId("visual-block-open-wide")).toBeNull();
  });
});

describe("a flow in a narrow container", () => {
  // jsdom never measures a node, so a line survives here with or without its ends; a browser
  // re-reads each node's ends from the DOM at its first measure and drops a line that has none
  it("gives every node the two ends a browser reads its lines from", async () => {
    show({ v: 1, kind: "flow", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] });
    const nodes = await screen.findAllByTestId("flow-node");
    for (const n of nodes) {
      expect(n.querySelector(".react-flow__handle.target.react-flow__handle-top")).toBeTruthy();
      expect(n.querySelector(".react-flow__handle.source.react-flow__handle-bottom")).toBeTruthy();
    }
  });

  it("scrolls at the diagram's own width instead of shrinking it", async () => {
    const wideFlow = {
      v: 1,
      kind: "flow",
      nodes: Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, label: `Step number ${i}` })),
      edges: Array.from({ length: 7 }, (_, i) => ({ from: "n0", to: `n${i + 1}` })),
    };
    show(wideFlow);
    const canvas = await screen.findByTestId("flow-canvas");
    expect(screen.getByTestId("flow-scroll").className).toMatch(/\boverflow-auto\b/);
    // eight siblings side by side are wider than a 375px panel: the canvas keeps that width
    await waitFor(() => expect(Number.parseFloat(canvas.style.minWidth)).toBeGreaterThan(375));
  });

  it("draws a long chain at its own height inside a bounded box that scrolls, never scaled down", async () => {
    const chain = {
      v: 1,
      kind: "flow",
      nodes: Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, label: `Step ${i}` })),
      edges: Array.from({ length: 19 }, (_, i) => ({ from: `s${i}`, to: `s${i + 1}` })),
    };
    show(chain);
    const canvas = await screen.findByTestId("flow-canvas");
    // twenty 36px steps with 28px between them: well past the 520px box
    expect(Number.parseFloat(canvas.style.height)).toBeGreaterThan(1200);
    expect(screen.getByTestId("flow-scroll").className).toMatch(/\bmax-h-\[520px\]/);
    // the canvas takes no touch gesture, so a finger scrolls the box; that it is drawn at zoom 1 jsdom
    // cannot show (it never measures a node, so it never fits a view): the browser harness measures it
    expect(document.querySelector(".react-flow")?.className).toContain("[&_.react-flow__pane]:touch-auto");
  });
});
