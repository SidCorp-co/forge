// The page `chrome-app` runs for the jump-to-end proof: 1,300 rows of unequal height drawn by the
// design layer's own `VirtualList` and `DataTable`, a jump to the end, and where it came to rest.
// `location.hash` is "<scenario>:<words>": how the jump is made, and how long the longest row is.
import { createRoot } from "react-dom/client";
import { DataTable, type DataTableColumn } from "@/design/patterns/data-table";
import { VirtualList } from "@/design/patterns/virtual-list";

const COUNT = 1300;

interface Row {
  id: string;
  words: number;
}

const [scenario = "", longest = "40"] = decodeURIComponent(location.hash.slice(1)).split(":");
const rows: Row[] = Array.from({ length: COUNT }, (_, i) => ({ id: `r${i}`, words: 3 + ((i * 37) % Number(longest)) }));
const sentence = (n: number) => Array.from({ length: n }, (_, k) => `word${k}`).join(" ");

const columns: DataTableColumn<Row>[] = [
  { id: "id", header: "Row", sticky: true, cell: (row) => row.id },
  { id: "note", header: "Note", cell: (row) => <p className="min-w-48">{sentence(row.words)}</p> },
];

function App() {
  return scenario.startsWith("table") ? (
    <DataTable aria-label="Rows" rows={rows} columns={columns} getRowId={(row) => row.id} />
  ) : (
    <VirtualList
      aria-label="Rows"
      rows={rows}
      getRowId={(row) => row.id}
      renderRow={(row) => <p className="px-4 py-3">{`${row.id} ${sentence(row.words)}`}</p>}
    />
  );
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function run() {
  createRoot(document.getElementById("root") as HTMLElement).render(<App />);
  await sleep(300);
  const table = scenario.startsWith("table");
  const scroller = (table ? document.querySelector("table")?.parentElement : document.querySelector('[role="feed"]')?.parentElement) as HTMLElement;
  const drawn = () => Array.from(scroller.querySelectorAll<HTMLElement>("[data-index]"));
  const first = drawn()[0] as HTMLElement;

  if (scenario === "list-key") {
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", ctrlKey: true, bubbles: true, cancelable: true }));
  } else {
    scroller.scrollTop = scroller.scrollHeight;
  }
  await sleep(1500);

  const last = drawn().find((el) => el.dataset.index === String(COUNT - 1));
  const frame = scroller.getBoundingClientRect();
  const report = {
    scenario,
    scrollTop: Math.round(scroller.scrollTop),
    farthest: Math.round(scroller.scrollHeight - scroller.clientHeight),
    lastDrawn: last !== undefined,
    // How far the last row's bottom edge sits below the frame's: 0 is landed on it, more is short of it.
    shortBy: last ? Math.round(last.getBoundingClientRect().bottom - frame.bottom) : null,
    drawn: drawn().length,
    focused: (document.activeElement as HTMLElement | null)?.dataset.index ?? null,
  };
  parent.postMessage(btoa(JSON.stringify(report)), "*");
}

run();
