// The page the End-key proof runs: the design layer's own VirtualList and a DataTable of 150 rows
// (every row with an action to put focus in), rows of unequal height. `location.hash` is
// "<list|table>:<words>"; the test presses real keys and asks `window.landing()` where the list rests.
import { createRoot } from "react-dom/client";
import { DataTable, type DataTableColumn } from "@/design/patterns/data-table";
import { VirtualList } from "@/design/patterns/virtual-list";

interface Row {
  id: string;
  words: number;
}

const [kind = "table", longest = "40"] = decodeURIComponent(location.hash.slice(1)).split(":");
const COUNT = kind === "table" ? 150 : 1300;
const rows: Row[] = Array.from({ length: COUNT }, (_, i) => ({ id: `r${i}`, words: 3 + ((i * 37) % Number(longest)) }));
const sentence = (n: number) => Array.from({ length: n }, (_, k) => `word${k}`).join(" ");

const columns: DataTableColumn<Row>[] = [
  { id: "id", header: "Row", sticky: true, cell: (row) => row.id },
  { id: "note", header: "Note", cell: (row) => <p className="min-w-48">{sentence(row.words)}</p> },
  { id: "act", header: null, headerLabel: "Actions", cell: (row) => <button type="button">{`open ${row.id}`}</button> },
];

createRoot(document.getElementById("root") as HTMLElement).render(
  kind === "table" ? (
    <DataTable aria-label="Rows" rows={rows} columns={columns} getRowId={(row) => row.id} />
  ) : (
    <VirtualList
      aria-label="Rows"
      rows={rows}
      getRowId={(row) => row.id}
      renderRow={(row) => <p className="px-4 py-3">{`${row.id} ${sentence(row.words)}`}</p>}
    />
  ),
);

const scroller = () => (kind === "table" ? document.querySelector("table")?.parentElement : document.querySelector('[role="feed"]')?.parentElement) as HTMLElement;
const drawn = () => Array.from(scroller().querySelectorAll<HTMLElement>("[data-index]"));

Object.assign(window, {
  /** Focuses the control of the first drawn row: the list's row itself, the table's action button. */
  focusFirst: () => {
    const row = drawn()[0] as HTMLElement;
    (kind === "table" ? (row.querySelector("button") as HTMLElement) : row).focus();
  },
  /** Where the list rests: whether the last row is drawn, and how far its bottom is from the frame's bottom (0 is on it). */
  landing: () => {
    const last = drawn().find((el) => el.dataset.index === String(COUNT - 1));
    return {
      lastDrawn: last !== undefined,
      shortBy: last ? Math.round(last.getBoundingClientRect().bottom - scroller().getBoundingClientRect().bottom) : null,
      focused: (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-index]")?.dataset.index ?? null,
    };
  },
  /** Whether the first row is in view, and which row holds focus. */
  atTop: () => {
    const first = drawn().find((el) => el.dataset.index === "0");
    const frame = scroller().getBoundingClientRect();
    const box = first?.getBoundingClientRect();
    return {
      firstInView: box !== undefined && box.bottom > frame.top && box.top < frame.bottom,
      focused: (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-index]")?.dataset.index ?? null,
    };
  },
  ready: false,
});
Promise.all([document.fonts.load('400 15px "Hanken Grotesk"'), new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))]).then(() => {
  (window as unknown as { ready: boolean }).ready = true;
});
