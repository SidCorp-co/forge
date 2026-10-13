
import type { ReportField } from "@forge/contracts/report-queries";
import { cellText, type VisualBlockOf, tableRows } from "@forge/contracts/visual-blocks";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import { Table, TBody, TD, TH, THead, TR, keyedByContent } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import { Cell } from "./cells";
import { useBlockInstants } from "./instants";

const NUMERIC = new Set(["number", "duration"]);

/** The rows a table shows before it is asked for the rest: a chat answer stays one screen tall. */
export const TABLE_ROW_CAP = 10;

/**
 * How a column's cells hold their width in a narrow container. A text column never squeezes below a
 * readable measure: it keeps a minimum width, wraps to two lines at most, and carries its full text
 * on hover. A figure, a date, a key or a state never wraps, and a figure is right-aligned in
 * tabular digits so a column of them reads down.
 */
function cellClass(f: ReportField): string {
  if (NUMERIC.has(f.type)) return "whitespace-nowrap text-right tabular-nums";
  if (f.type === "string") return "";
  return "whitespace-nowrap";
}

/**
 * A text cell: a readable minimum width, two lines at most, the whole text on hover, and a tap or a
 * key that opens it in place, so a reader without a pointer still reaches its last sentence.
 */
function ClampedText({ text, children }: { text: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className={cn(
        "block min-w-40 max-w-80 cursor-text text-left focus-visible:outline-none focus-visible:shadow-focus",
        !open && "line-clamp-2 print:line-clamp-none",
      )}
      title={text}
      aria-expanded={open}
      onClick={() => setOpen((o) => !o)}
      data-testid="table-text"
    >
      {children}
    </button>
  );
}

/**
 * Whether the page is being printed: true from the browser's `beforeprint` to its `afterprint`,
 * rendered synchronously so the printed copy already holds what the flag shows.
 */
function usePrinting(): boolean {
  // an external store's change renders synchronously, so the printed copy already holds the flag
  return useSyncExternalStore(subscribePrinting, () => printing, () => false);
}

let printing = false;
const printListeners = new Set<() => void>();
const setPrintingTo = (on: boolean) => () => {
  printing = on;
  for (const listener of printListeners) listener();
};
const startPrinting = setPrintingTo(true);
const endPrinting = setPrintingTo(false);

function subscribePrinting(onChange: () => void): () => void {
  if (printListeners.size === 0) {
    window.addEventListener("beforeprint", startPrinting);
    window.addEventListener("afterprint", endPrinting);
  }
  printListeners.add(onChange);
  return () => {
    printListeners.delete(onChange);
    if (printListeners.size > 0) return;
    window.removeEventListener("beforeprint", startPrinting);
    window.removeEventListener("afterprint", endPrinting);
  };
}

/** The first column stays put while the rest scroll sideways, on the page's own ground so nothing shows through it. */
const STICKY = "sticky left-0 z-1 bg-app";

/**
 * A table block: the frame's chosen columns as a flush table on hairlines, sorted and cut as the
 * block says. It scrolls sideways inside its container rather than squeeze its text, and shows its
 * first rows with a control for the rest.
 */
export function TableBlockView({ block }: { block: VisualBlockOf<"table"> }) {
  const [all, setAll] = useState(false);
  const t = useCopy();
  const instants = useBlockInstants();
  // a printed table holds every row it shows: paper has no "Show all"
  const printing = usePrinting();
  const fields = block.columns.flatMap((c) => block.frame.fields.filter((f) => f.name === c));
  const rows = tableRows(block);
  const shown = all || printing ? rows : rows.slice(0, TABLE_ROW_CAP);
  const hidden = block.frame.rows.length - rows.length;
  return (
    <div className="min-w-0">
      <Table className="text-13">
        <THead>
          <TR>
            {fields.map((f, c) => (
              <TH
                key={f.name}
                scope="col"
                className={cn(
                  "py-1.5 pl-0 pr-4 align-bottom font-sans text-12 font-semibold normal-case tracking-normal text-subtle",
                  NUMERIC.has(f.type) && "text-right",
                  c === 0 && STICKY,
                )}
                data-type={f.type}
              >
                {f.label}
              </TH>
            ))}
          </TR>
        </THead>
        <TBody>
          {keyedByContent(shown).map(({ key, item: row }) => (
            // a frame row has no key of its own: its cells, and which repeat of them it is
            <TR key={key} className="hover:bg-transparent">
              {fields.map((f, c) => (
                <TD key={f.name} className={cn("py-1.5 pl-0 pr-4 align-top text-13", cellClass(f), c === 0 && STICKY)} data-type={f.type}>
                  {f.type === "string" ? (
                    <ClampedText text={cellText(f, row[f.name], instants)}>
                      <Cell field={f} cell={row[f.name]} />
                    </ClampedText>
                  ) : (
                    <Cell field={f} cell={row[f.name]} />
                  )}
                </TD>
              ))}
            </TR>
          ))}
        </TBody>
      </Table>
      {rows.length === 0 && <p className="py-1.5 text-12 text-subtle">{t("visual.table.empty")}</p>}
      {rows.length > TABLE_ROW_CAP && (
        <button
          type="button"
          className="mt-1 text-12 font-medium text-link hover:underline focus-visible:outline-none focus-visible:shadow-focus print:hidden"
          aria-expanded={all}
          onClick={() => setAll((a) => !a)}
          data-testid="table-show-all"
        >
          {all ? t("visual.table.showFirst", { n: TABLE_ROW_CAP }) : t("visual.table.showAll", { n: rows.length })}
        </button>
      )}
      {hidden > 0 && (
        <p className="py-1 text-12 text-subtle">
          {t("visual.table.showing", { shown: rows.length, total: block.frame.rows.length })}
        </p>
      )}
    </div>
  );
}
